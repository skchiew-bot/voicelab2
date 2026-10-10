/**
 * A live call through the speech relay: the conversation between the caller and the workflow the call runs. Twilio
 * hears the caller and speaks our lines; this decides what is said. It works on messages, not sockets, so it is tested
 * without a network (`app.ts` connects it to the WebSocket).
 *
 * A connection is trusted only after Twilio's signature on it is checked (in `app.ts`), and then only for the call it
 * names, on the provider it came in on, with the call's own Twilio id. Nothing the caller says is logged here: it goes
 * to the run, which keeps it without numbers, and keeps nothing of a sensitive answer.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { DEFAULT_FALLBACK } from '../resilience/fallback.js';
import { sayMessages, type RelayInbound, type RelayOutbound } from '../telephony/relay.js';
import { recordEvent } from './events.js';
import { addCallbackRequest, getFallbackPlan } from './resilience.js';
import { abandonRow, abandonRun, replyRunSpoken, startRunSpoken, type RunDeps, type SpokenLine } from './runs.js';

export interface RelayDeps { runs: RunDeps; baseUrl: string; now?: () => Date }

/**
 * One open conversation. `version` is the question the call is on, so a late answer to an earlier one is not applied.
 * `owner` names this connection: the call is served by the connection that last took it over, and only that one may end
 * its run on closing.
 */
export interface RelaySession { providerId: string; callId: string; tenantId: string; projectId: string | null; runId: string | null; version: number; ended: boolean; owner: string }

const asInternal = <T>(d: RelayDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.runs.pool, { kind: 'internal' }, fn);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN = ['ringing', 'in_progress', 'queued', 'dialing'];

// ------------------------------------------------------------------ the call's own key
/**
 * Every relay connection to a provider carries the same Twilio signature (Twilio signs the bare address), so the
 * signature alone does not say which call a connection may serve. The TwiML that hands a call to the relay also carries
 * this key, made for that one call; a connection must present it to be served.
 */
const callKey = (key: Buffer) => createHmac('sha256', key).update('voicelab relay call v1').digest();
export const relayCallToken = (key: Buffer, callId: string) => createHmac('sha256', callKey(key)).update(callId).digest('hex');
function callTokenValid(key: Buffer, callId: string, token: unknown): boolean {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(relayCallToken(key, callId), 'hex'), Buffer.from(token, 'hex'));
}

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

/** A start that has produced no run in this long died with the server that was running it. */
export const STARTING_GRACE_MS = 30_000;
/** A reply claimed this long ago and still not applied died with the server that was applying it. */
export const STUCK_REPLY_MS = 60_000;

type Opening =
  | { kind: 'refuse' } | { kind: 'over' } | { kind: 'end' } | { kind: 'standby' } | { kind: 'died' } | { kind: 'start'; workflowId: string }
  | { kind: 'resume'; run: { id: string; status: string; outcome: string | null; state_version: number; stuck: boolean } };

/**
 * The relay has connected for a call. Check that it is the call it says it is, then start the call's workflow, or take
 * over the one already under way (a reconnect never starts the workflow again). The decision is made in one short
 * transaction holding the call's row; nothing is held while the workflow runs.
 */
export async function openRelay(d: RelayDeps, providerId: string, setup: Extract<RelayInbound, { type: 'setup' }>): Promise<{ session: RelaySession | null; send: RelayOutbound[] }> {
  const callId = setup.customParameters?.callId;
  if (typeof callId !== 'string' || !UUID.test(callId) || !callTokenValid(d.runs.key, callId, setup.customParameters?.token)) return { session: null, send: [{ type: 'end' }] };
  const owner = randomUUID();
  type Row = { tenant_id: string; project_id: string | null; provider_id: string; provider_call_id: string | null; status: string; workflow_id: string | null; relay_owner: string | null; relay_failed: boolean; claim_fresh: boolean | null };
  let call: Row | undefined;
  const opening = await asInternal(d, async (c): Promise<Opening> => {
    call = (await c.query(
      `SELECT id, tenant_id, project_id, provider_id, provider_call_id, status, workflow_id, relay_owner, relay_failed,
              relay_claimed_at > now() - make_interval(secs => $2) AS claim_fresh
         FROM calls WHERE id = $1 FOR UPDATE`, [callId, STARTING_GRACE_MS / 1000])).rows[0];
    // Not this provider's call, or not the call Twilio says it is: nothing is said and nothing is started.
    if (!call || call.provider_id !== providerId || call.provider_call_id !== setup.callSid) return { kind: 'refuse' };
    const row = call;
    if (row.relay_failed) return { kind: 'over' };
    const run = (await c.query(
      `SELECT id, status, outcome, state_version, (status = 'processing' AND claimed_at < now() - make_interval(secs => $2)) AS stuck
         FROM workflow_runs WHERE call_id = $1 AND kind = 'live'`, [callId, STUCK_REPLY_MS / 1000])).rows[0];
    const claim = () => c.query('UPDATE calls SET relay_owner = $2, relay_claimed_at = now() WHERE id = $1', [callId, owner]);
    if (run) { await claim(); return { kind: 'resume', run }; }
    if (!OPEN.includes(row.status) || !row.workflow_id) return { kind: 'end' };
    if (row.relay_owner && row.claim_fresh) return { kind: 'standby' };            // another connection is starting it now
    // A start that never finished: what it did is unknown, so it is not done again (L-002); the caller gets the fallback.
    if (row.relay_owner) { await claim(); return { kind: 'died' }; }
    await claim();
    return { kind: 'start', workflowId: row.workflow_id };
  });
  if (opening.kind === 'refuse' || !call) return { session: null, send: [{ type: 'end' }] };
  const session: RelaySession = { providerId, callId, tenantId: call.tenant_id, projectId: call.project_id, runId: null, version: 0, ended: false, owner };
  await event(d, session, 'relay.connected', { opening: opening.kind });
  switch (opening.kind) {
    case 'over': case 'end': return finish(session, [{ type: 'end' }]);
    case 'standby': return { session, send: [] };
    case 'died': return failed(d, session);
    case 'resume': {
      session.runId = opening.run.id; session.version = opening.run.state_version;
      if (opening.run.status === 'ended') return finish(session, [endMessage(opening.run.outcome)]);
      if (opening.run.stuck) return failed(d, session);
      return { session, send: [] };   // carry on: the next thing the caller says answers the question already asked
    }
    case 'start':
      try {
        const r = await startRunSpoken(d.runs, null, { workflowId: opening.workflowId, environment: 'production', kind: 'live', variables: {}, callId });
        session.runId = r.view.id; session.version = r.view.version;
        return afterTurn(d, session, r.view, r.speech);
      } catch { return failed(d, session); }
  }
}

/**
 * Something came from the relay. The caller's finished words are the answer to the question the call was on when they
 * finished speaking (`askedAt`); anything they say while that answer is being worked out was said before the next
 * question, so it is not applied to it.
 */
export async function onRelayMessage(d: RelayDeps, session: RelaySession, m: RelayInbound, askedAt?: number): Promise<RelayOutbound[]> {
  if (session.ended) return [];
  if (m.type === 'error') { await event(d, session, 'relay.error', { by: 'provider' }); return []; }
  if (m.type !== 'prompt' || m.last === false || m.voicePrompt.trim() === '') return [];
  // A connection that stood by while another started the call takes it over once the run exists.
  if (!session.runId && !(await adopt(d, session))) return [];
  const asked = askedAt ?? session.version;
  try {
    const r = await replyRunSpoken(d.runs, session.runId!, m.voicePrompt, asked);
    session.version = r.view.version;
    return (await afterTurn(d, session, r.view, r.speech)).send;
  } catch (e) {
    if (!(e instanceof AppError && e.status === 409)) return (await failed(d, session)).send;
    // Refused because the call is not where these words were said: say why, from the run itself.
    const run = await asInternal(d, async (c) => (await c.query(
      `SELECT status, outcome, state_version, claimed_at > now() - make_interval(secs => $2) AS fresh FROM workflow_runs WHERE id = $1`, [session.runId, STUCK_REPLY_MS / 1000])).rows[0]);
    if (run?.status === 'ended') return finish(session, [endMessage(run.outcome)]).send;
    if (run?.status === 'awaiting_reply' && run.state_version !== asked) return [];   // the words were for an earlier question
    if (run?.status === 'processing' && run.fresh) return [];                          // another answer is being applied now
    return (await failed(d, session)).send;                                           // stuck: never leave the caller in silence
  }
}

/** Take over a call whose run another connection started. False if there is no run yet. */
async function adopt(d: RelayDeps, session: RelaySession): Promise<boolean> {
  const run = await asInternal(d, async (c) => {
    await c.query('SELECT 1 FROM calls WHERE id = $1 FOR UPDATE', [session.callId]);
    const r = (await c.query(`SELECT id, state_version FROM workflow_runs WHERE call_id = $1 AND kind = 'live'`, [session.callId])).rows[0];
    if (r) await c.query('UPDATE calls SET relay_owner = $2, relay_claimed_at = now() WHERE id = $1', [session.callId, session.owner]);
    return r;
  });
  if (!run) return false;
  session.runId = run.id; session.version = run.state_version;
  return true;
}

/**
 * The relay closed. If this connection still serves the call, a run still waiting is ended now, which wipes anything
 * sensitive it held. A connection another has taken over leaves the run alone.
 */
export async function closeRelay(d: RelayDeps, session: RelaySession): Promise<void> {
  const wasEnded = session.ended;
  session.ended = true;
  await asInternal(d, async (c) => {
    const call = (await c.query('SELECT relay_owner FROM calls WHERE id = $1 FOR UPDATE', [session.callId])).rows[0];
    if (call?.relay_owner !== session.owner) return;
    await c.query('UPDATE calls SET relay_owner = NULL WHERE id = $1', [session.callId]);
    const run = (await c.query(`SELECT id, state FROM workflow_runs WHERE call_id = $1 AND kind = 'live' AND status IN ('running', 'awaiting_reply') FOR UPDATE`, [session.callId])).rows[0];
    if (run) await abandonRow(c, run);
  }).catch(() => undefined);
  await event(d, session, 'relay.closed', { finished: wasEnded }).catch(() => undefined);
}

function afterTurn(d: RelayDeps, session: RelaySession, view: { status: string; outcome: string | null; error: string | null }, speech: SpokenLine[]) {
  const send = say(d, speech);
  if (view.status !== 'ended') return Promise.resolve({ session, send });
  // A workflow that broke part-way (whatever its outcome is called, e.g. a client's system failing) is not a finished
  // call: the caller gets the fallback, never silence.
  if (view.outcome === 'error' || view.error !== null) return failed(d, session, send);
  return Promise.resolve(finish(session, [...send, endMessage(view.outcome)]));
}

function finish(session: RelaySession, send: RelayOutbound[]) { session.ended = true; return { session, send }; }

/**
 * Something broke. The callback request is recorded first, so it cannot be lost, then the caller hears the client's
 * holding message (or the default) and the call ends. Never silence, never a dead line. A call falls back once: a
 * reconnect after it does not record a second callback request.
 */
export async function failed(d: RelayDeps, session: RelaySession, already: RelayOutbound[] = []) {
  const plan = await asInternal(d, async (c) => {
    const first = (await c.query('UPDATE calls SET relay_failed = true WHERE id = $1 AND NOT relay_failed RETURNING id', [session.callId])).rowCount === 1;
    if (first) await addCallbackRequest(c, { tenantId: session.tenantId, callId: session.callId, reason: 'the live call could not carry on' });
    return (await getFallbackPlan(c, session.tenantId)) ?? DEFAULT_FALLBACK;
  }).catch(() => DEFAULT_FALLBACK);
  await event(d, session, 'relay.fallback', { steps: ['record_callback_request', 'holding_message'] }).catch(() => undefined);
  if (session.runId) await abandonRun(d.runs, session.runId).catch(() => false);
  return finish(session, [...already, { type: 'text', token: plan.holdingMessage, last: true }, { type: 'end' }]);
}

const event = (d: RelayDeps, s: RelaySession, type: string, payload: Record<string, unknown>) =>
  asInternal(d, (c) => recordEvent(c, { tenantId: s.tenantId, projectId: s.projectId ?? undefined, callId: s.callId, type, payload }));
