/**
 * A live call through the speech relay: the conversation between the caller and the workflow the call runs. Twilio
 * hears the caller and speaks our lines; this decides what is said. It works on messages, not sockets, so it is tested
 * without a network (`app.ts` connects it to the WebSocket).
 *
 * A connection is trusted only after Twilio's signature on it is checked (in `app.ts`), and then only for the call it
 * names, on the provider it came in on, with the call's own Twilio id. Nothing the caller says is logged here: it goes
 * to the run, which keeps it without numbers, and keeps nothing of a sensitive answer.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { DEFAULT_FALLBACK } from '../resilience/fallback.js';
import { sayMessages, type RelayInbound, type RelayOutbound } from '../telephony/relay.js';
import { recordEvent } from './events.js';
import { addCallbackRequest, getFallbackPlan } from './resilience.js';
import { abandonRun, replyRunSpoken, startRunSpoken, type RunDeps, type SpokenLine } from './runs.js';

export interface RelayDeps { runs: RunDeps; baseUrl: string; now?: () => Date }

/** One open conversation. `version` is the question the call is on, so a late answer to an earlier one is not applied. */
export interface RelaySession { providerId: string; callId: string; tenantId: string; projectId: string | null; runId: string | null; version: number; ended: boolean }

const asInternal = <T>(d: RelayDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.runs.pool, { kind: 'internal' }, fn);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN = ['ringing', 'in_progress', 'queued', 'dialing'];

// ------------------------------------------------------------------ recording links
/** How long a link to a recording works: long enough for the relay to fetch it, too short to be worth keeping. */
export const MEDIA_LINK_SECONDS = 10 * 60;
const mediaKey = (key: Buffer) => createHmac('sha256', key).update('voicelab media link v1').digest();
const mediaSig = (key: Buffer, id: string, exp: number) => createHmac('sha256', mediaKey(key)).update(`${id}.${exp}`).digest('hex');

/** A link the relay can fetch a recording from. Recordings stay internal: the link names one recording and expires. */
export function mediaLink(baseUrl: string, key: Buffer, recordingId: string, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + MEDIA_LINK_SECONDS;
  return `${baseUrl}/media/recordings/${recordingId}?exp=${exp}&sig=${mediaSig(key, recordingId, exp)}`;
}

/** Whether a link is one we made, for this recording, and still in date. */
export function mediaLinkValid(key: Buffer, recordingId: string, exp: string | undefined, sig: string | undefined, now: Date): boolean {
  if (!UUID.test(recordingId) || !exp || !/^\d{1,12}$/.test(exp) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const e = Number(exp); const t = now.getTime() / 1000;
  if (e < t || e > t + MEDIA_LINK_SECONDS + 60) return false;
  return timingSafeEqual(Buffer.from(mediaSig(key, recordingId, e), 'hex'), Buffer.from(sig, 'hex'));
}

// ------------------------------------------------------------------ the conversation
const say = (d: RelayDeps, lines: SpokenLine[]) => sayMessages(lines, (id) => mediaLink(d.baseUrl, d.runs.key, id, (d.now ?? (() => new Date()))()));

/** What a finished run leaves to say: nothing more, then the end. A call passed to a person says so to whatever runs next. */
const endMessage = (outcome: string | null): RelayOutbound => (outcome === 'handoff_human' ? { type: 'end', handoffData: JSON.stringify({ reason: 'handoff_human' }) } : { type: 'end' });

/**
 * The relay has connected for a call. Check that it is the call it says it is, then start the call's workflow, or carry
 * on the one already under way (a reconnect never starts the workflow again: it holds a lock on the call while it
 * looks, and the database allows one live run per call).
 */
export async function openRelay(d: RelayDeps, providerId: string, setup: Extract<RelayInbound, { type: 'setup' }>): Promise<{ session: RelaySession | null; send: RelayOutbound[] }> {
  const callId = setup.customParameters?.callId;
  if (typeof callId !== 'string' || !UUID.test(callId)) return { session: null, send: [{ type: 'end' }] };
  const pool = d.runs.pool;
  const lock = await pool.connect();
  try {
    // Held across the start, on its own connection, so two connections for one call take turns.
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`relay:${callId}`]);
    const found = await asInternal(d, async (c) => {
      const call = (await c.query('SELECT id, tenant_id, project_id, provider_id, provider_call_id, status, workflow_id FROM calls WHERE id = $1', [callId])).rows[0];
      if (!call || call.provider_id !== providerId || call.provider_call_id !== setup.callSid) return null;
      const run = (await c.query(`SELECT id, status, outcome, state_version FROM workflow_runs WHERE call_id = $1 AND kind = 'live'`, [callId])).rows[0];
      return { call, run };
    });
    // Not this provider's call, or not the call Twilio says it is: nothing is said and nothing is started.
    if (!found) return { session: null, send: [{ type: 'end' }] };
    const { call, run } = found;
    const session: RelaySession = { providerId, callId, tenantId: call.tenant_id, projectId: call.project_id, runId: run?.id ?? null, version: run?.state_version ?? 0, ended: false };
    await event(d, session, 'relay.connected', { resumed: Boolean(run) });
    if (run) {
      if (run.status === 'ended') return finish(session, [endMessage(run.outcome)]);
      return { session, send: [] };   // carry on: the next thing the caller says answers the question already asked
    }
    if (!OPEN.includes(call.status) || !call.workflow_id) return finish(session, [{ type: 'end' }]);
    try {
      const r = await startRunSpoken(d.runs, null, { workflowId: call.workflow_id, environment: 'production', kind: 'live', variables: {}, callId });
      session.runId = r.view.id; session.version = r.view.version;
      return afterTurn(d, session, r.view, r.speech);
    } catch (e) { return failed(d, session, e); }
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`relay:${callId}`]).catch(() => undefined);
    lock.release();
  }
}

/**
 * Something came from the relay. The caller's finished words are the answer to the question the call was on when they
 * finished speaking; anything they say while that answer is being worked out was said before the next question, so it
 * is not applied to it.
 */
export async function onRelayMessage(d: RelayDeps, session: RelaySession, m: RelayInbound, askedAt: number): Promise<RelayOutbound[]> {
  if (session.ended || !session.runId) return [];
  if (m.type === 'error') { await event(d, session, 'relay.error', { by: 'provider' }); return []; }
  if (m.type !== 'prompt' || m.last === false || m.voicePrompt.trim() === '') return [];
  try {
    const r = await replyRunSpoken(d.runs, session.runId, m.voicePrompt, askedAt);
    session.version = r.view.version;
    return (await afterTurn(d, session, r.view, r.speech)).send;
  } catch (e) {
    // The call had already moved on, or the run had ended: not a failure, the words were for an earlier moment.
    if (e instanceof AppError && e.status === 409) {
      const ended = await asInternal(d, async (c) => (await c.query(`SELECT status, outcome FROM workflow_runs WHERE id = $1`, [session.runId])).rows[0]);
      if (ended?.status === 'ended') return finish(session, [endMessage(ended.outcome)]).send;
      return [];
    }
    return (await failed(d, session, e)).send;
  }
}

/** The relay closed. A run still waiting is ended now, which wipes anything sensitive it held. */
export async function closeRelay(d: RelayDeps, session: RelaySession): Promise<void> {
  if (session.runId && !session.ended) await abandonRun(d.runs, session.runId).catch(() => false);
  await event(d, session, 'relay.closed', { finished: session.ended }).catch(() => undefined);
  session.ended = true;
}

function afterTurn(d: RelayDeps, session: RelaySession, view: { status: string; outcome: string | null; error: string | null }, speech: SpokenLine[]) {
  const send = say(d, speech);
  if (view.status !== 'ended') return Promise.resolve({ session, send });
  // A workflow that broke part-way (whatever its outcome is called, e.g. a client's system failing) is not a finished
  // call: the caller gets the fallback, never silence.
  if (view.outcome === 'error' || view.error !== null) return failed(d, session, new Error('workflow error'), send);
  return Promise.resolve(finish(session, [...send, endMessage(view.outcome)]));
}

function finish(session: RelaySession, send: RelayOutbound[]) { session.ended = true; return { session, send }; }

/**
 * Something broke. The callback request is recorded first, so it cannot be lost, then the caller hears the client's
 * holding message (or the default) and the call ends. Never silence, never a dead line.
 */
async function failed(d: RelayDeps, session: RelaySession, _e: unknown, already: RelayOutbound[] = []) {
  const plan = await asInternal(d, async (c) => {
    await addCallbackRequest(c, { tenantId: session.tenantId, callId: session.callId, reason: 'the live call could not carry on' });
    return (await getFallbackPlan(c, session.tenantId)) ?? DEFAULT_FALLBACK;
  }).catch(() => DEFAULT_FALLBACK);
  await event(d, session, 'relay.fallback', { steps: ['record_callback_request', 'holding_message'] }).catch(() => undefined);
  if (session.runId) await abandonRun(d.runs, session.runId).catch(() => false);
  return finish(session, [...already, { type: 'text', token: plan.holdingMessage, last: true }, { type: 'end' }]);
}

const event = (d: RelayDeps, s: RelaySession, type: string, payload: Record<string, unknown>) =>
  asInternal(d, (c) => recordEvent(c, { tenantId: s.tenantId, projectId: s.projectId ?? undefined, callId: s.callId, type, payload }));
