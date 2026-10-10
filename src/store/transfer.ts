/**
 * Putting a live caller through to a person. When the speech relay session ends, Twilio asks what to do next (the
 * `<Connect action>` request). If the call's workflow passed it to a person, the client's agent phone is rung, showing
 * one of our own numbers; if no one answers, the callback ladder runs: a callback request is recorded first, then the
 * caller hears the client's holding message and the call ends. Never silence, never a dead line.
 *
 * Whether the call goes to a person is read from our own record of the run (its outcome), not from what the request
 * says (lesson L-039). The caller's number arrives in every Twilio request; it is never stored, logged or passed on.
 * Every request is verified by Twilio's signature in `app.ts` before it reaches here, and names the call it is for.
 */
import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { DEFAULT_FALLBACK } from '../resilience/fallback.js';
import { agentNumberAllowed, dialOutcome, dialSeconds, twimlDialAgent, twimlEmpty, twimlHangup, twimlHoldingThenHangup, twimlWhisper, whisperText } from '../telephony/transfer.js';
export { twimlHangup, twimlHoldingThenHangup };
import { audit } from './audit.js';
import { costCall } from './calls.js';
import { isFull, providerLoad } from './concurrency.js';
import { normalizeE164 } from './dnc.js';
import { recordEvent } from './events.js';
import { addCallbackRequest, getFallbackPlan } from './resilience.js';

export interface TransferDeps { pool: pg.Pool; baseUrl: string }
export interface TransferSettings { agentNumber: string; ringSeconds: number; whisper: boolean }

// ------------------------------------------------------------------ settings
/**
 * Where a client's calls go when passed to a person. The agent's number is the client's staff line and is stored; it is
 * never one of our own numbers (that would ring back into us). The audit records that it changed, not the number.
 */
export async function setTransferSettings(c: pg.PoolClient, actorId: string | null, tenantId: string, s: TransferSettings) {
  const agent = normalizeE164(s.agentNumber);
  if (!agent) throw new AppError(400, 'The agent number must be a full international number, such as +60312345678.');
  if (!agentNumberAllowed(agent)) throw new AppError(400, 'For now the agent number must be a Malaysian number (+60).');
  if ((await c.query('SELECT 1 FROM phone_numbers WHERE e164 = $1', [agent])).rowCount) throw new AppError(400, 'The agent number is one of our own numbers; a transfer to it would ring back into Voice Lab.');
  if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rowCount) throw new AppError(404, 'Client not found.');
  await c.query(
    `INSERT INTO transfer_settings (tenant_id, agent_e164, ring_seconds, whisper) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET agent_e164 = $2, ring_seconds = $3, whisper = $4, updated_at = now()`,
    [tenantId, agent, s.ringSeconds, s.whisper]);
  await audit(c, actorId, 'transfer.set', 'tenant', tenantId, { ringSeconds: s.ringSeconds, whisper: s.whisper });
  return getTransferSettings(c, tenantId);
}

export async function getTransferSettings(c: pg.PoolClient, tenantId: string): Promise<TransferSettings | null> {
  const r = (await c.query('SELECT agent_e164, ring_seconds, whisper FROM transfer_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? { agentNumber: r.agent_e164, ringSeconds: r.ring_seconds, whisper: r.whisper } : null;
}

/** Every client's transfer settings, for the console. Staff only: the client's own role cannot read this table. */
export async function listTransferSettings(c: pg.PoolClient) {
  return (await c.query(
    `SELECT t.id AS "tenantId", t.name AS tenant, s.agent_e164 AS "agentNumber", s.ring_seconds AS "ringSeconds", s.whisper, s.updated_at AS "updatedAt"
       FROM transfer_settings s JOIN tenants t ON t.id = s.tenant_id ORDER BY t.name, t.id`)).rows;
}

export async function clearTransferSettings(c: pg.PoolClient, actorId: string | null, tenantId: string) {
  const n = (await c.query('DELETE FROM transfer_settings WHERE tenant_id = $1', [tenantId])).rowCount ?? 0;
  if (n) await audit(c, actorId, 'transfer.clear', 'tenant', tenantId, {});
  return { cleared: n > 0 };
}

// ------------------------------------------------------------------ the call
const asInternal = <T>(d: TransferDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.pool, { kind: 'internal' }, fn);
const OPEN = ['ringing', 'in_progress', 'queued', 'dialing'];
/** Dial statuses that say the agent's leg never connected, so it costs nothing. */
const NEVER_CONNECTED = ['busy', 'no-answer', 'canceled', 'failed'];
/** Call statuses that say the caller has gone. Anything else (including a value we do not know) is taken as still there. */
const GONE = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

export type TransferStep = 'relay-ended' | 'whisper' | 'accept' | 'dialled';
export const transferUrl = (baseUrl: string, providerId: string, step: TransferStep, callId: string) =>
  `${baseUrl}/webhooks/twilio/${providerId}/transfer/${step}?callId=${callId}`;

type CallRow = { id: string; tenant_id: string; project_id: string | null; provider_id: string; provider_call_id: string | null; direction: string; status: string; from_number_id: string | null; relay_failed: boolean; transfer_status: string | null; transfer_accepted_at: Date | null; transfer_screened: boolean | null };

/** The call, locked, if it is the one the request is for: on this provider, with the Twilio call id it names. */
async function lockCall(c: pg.PoolClient, providerId: string, callId: string, callSid: string | undefined): Promise<CallRow> {
  const call = (await c.query(
    `SELECT id, tenant_id, project_id, provider_id, provider_call_id, direction, status, from_number_id, relay_failed, transfer_status,
            transfer_accepted_at, transfer_screened
       FROM calls WHERE id = $1 FOR UPDATE`, [callId])).rows[0] as CallRow | undefined;
  if (!call || call.provider_id !== providerId || !callSid || call.provider_call_id !== callSid) throw new AppError(404, 'Unknown call.');
  return call;
}

/** An event a retried request must not record twice. */
async function eventOnce(c: pg.PoolClient, call: CallRow, type: string, payload: Record<string, unknown> = {}) {
  if ((await c.query('SELECT 1 FROM call_events WHERE call_id = $1 AND type = $2', [call.id, type])).rowCount) return;
  await event(c, call, type, payload);
}

const event = (c: pg.PoolClient, call: CallRow, type: string, payload: Record<string, unknown> = {}) =>
  recordEvent(c, { tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId: call.id, type, payload });

/** The callback ladder: the request is recorded first, then the caller hears the holding message and the call ends. */
async function ladder(c: pg.PoolClient, call: CallRow, reason: string, record: boolean) {
  if (record) await addCallbackRequest(c, { tenantId: call.tenant_id, callId: call.id, reason });
  const plan = (await getFallbackPlan(c, call.tenant_id)) ?? DEFAULT_FALLBACK;
  return twimlHoldingThenHangup(plan.holdingMessage);
}

/**
 * The number the agent sees: the one of ours the call is on. An outbound call was dialled from one of ours; an inbound
 * call came in on one of ours (Twilio's `To`), which must be this client's number on this provider. Never the caller's.
 */
async function ourNumber(c: pg.PoolClient, call: CallRow, params: Record<string, string>): Promise<string | null> {
  if (call.direction === 'outbound') {
    if (!call.from_number_id) return null;
    return (await c.query('SELECT e164 FROM phone_numbers WHERE id = $1 AND tenant_id = $2', [call.from_number_id, call.tenant_id])).rows[0]?.e164 ?? null;
  }
  const to = params.To ? normalizeE164(params.To) : null;
  if (!to) return null;
  return (await c.query('SELECT e164 FROM phone_numbers WHERE e164 = $1 AND tenant_id = $2 AND provider_id = $3', [to, call.tenant_id, call.provider_id])).rows[0]?.e164 ?? null;
}

/**
 * How to ring the agent, or why it cannot be done. The agent number is checked again here (a setting stored before the
 * +60 rule, say). A new dial is a second leg on the call's provider, so it needs a free channel under the provider's
 * concurrency ceiling (decided under the `capacity` lock, which the caller holds); a full provider means the ladder.
 */
async function dialPlan(c: pg.PoolClient, d: TransferDeps, call: CallRow, params: Record<string, string>, o: { newLeg: boolean }) {
  const s = await getTransferSettings(c, call.tenant_id);
  const callerId = await ourNumber(c, call, params);
  if (!s || !callerId) return { twiml: null, why: !s ? 'no_agent_number' : 'no_own_number' } as const;
  if (!agentNumberAllowed(s.agentNumber)) return { twiml: null, why: 'agent_number_not_allowed' } as const;
  if (o.newLeg && isFull((await providerLoad(c, [call.provider_id])).get(call.provider_id)!)) return { twiml: null, why: 'at_capacity' } as const;
  return {
    twiml: twimlDialAgent({
      agent: s.agentNumber, callerId, ringSeconds: s.ringSeconds,
      actionUrl: transferUrl(d.baseUrl, call.provider_id, 'dialled', call.id),
      whisperUrl: s.whisper ? transferUrl(d.baseUrl, call.provider_id, 'whisper', call.id) : null,
    }), why: null, ringSeconds: s.ringSeconds, whisper: s.whisper,
  } as const;
}

/**
 * The relay session has ended and Twilio asks what next. A call the workflow passed to a person is put through to the
 * agent; a call that finished normally, or that the relay already fell back on, is hung up; a session that ended with
 * the conversation unfinished while the caller is still there gets the callback ladder, once.
 */
export async function afterRelay(d: TransferDeps, providerId: string, callId: string, params: Record<string, string>): Promise<string> {
  return asInternal(d, async (c) => {
    // Locks in one fixed order (lesson L-030): capacity first, as every dial does, then the call.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);
    const call = await lockCall(c, providerId, callId, params.CallSid);
    const present = !GONE.includes(params.CallStatus ?? '') && OPEN.includes(call.status);
    if (call.transfer_status === 'dialing') {
      // A retried request: the first answer may never have reached Twilio, so the same dial is given again.
      if (!present) return twimlHangup();
      // Its leg is already counted against the provider (a dialling transfer counts), so it is not counted again.
      const plan = await dialPlan(c, d, call, params, { newLeg: false });
      if (plan.twiml) return plan.twiml;
      // The agent number (or our own) went away between the two requests: the caller still gets the ladder.
      await c.query(`UPDATE calls SET transfer_status = 'failed' WHERE id = $1`, [callId]);
      await event(c, call, 'transfer.failed', { reason: plan.why });
      return ladder(c, call, 'the caller asked for a person and there was no one to put them through to', true);
    }
    if (call.transfer_status !== null) return twimlHangup();   // already put through, or already fallen back
    const run = (await c.query(`SELECT status, outcome, error FROM workflow_runs WHERE call_id = $1 AND kind = 'live'`, [callId])).rows[0] as
      { status: string; outcome: string | null; error: string | null } | undefined;
    const handoff = run?.status === 'ended' && run.outcome === 'handoff_human' && run.error === null;
    // The relay has already fallen back on this call (holding line said, callback recorded): a call falls back once, and
    // a caller told they will be called back is not then put through as well.
    if (call.relay_failed) return twimlHangup();
    if (!present) {
      // The caller asked for a person and hung up before anyone was rung: they did not reach one, so a callback is
      // recorded, once (the status moves forward, so a retried request or the call's end finds it settled).
      if (handoff) await abandonBeforeDial(c, call);
      return twimlHangup();
    }
    if (handoff) {
      const plan = await dialPlan(c, d, call, params, { newLeg: true });
      if (!plan.twiml) {
        await c.query(`UPDATE calls SET transfer_status = 'unavailable' WHERE id = $1`, [callId]);
        await event(c, call, 'transfer.unavailable', { reason: plan.why });
        return ladder(c, call, 'the caller asked for a person and there was no one to put them through to', true);
      }
      await c.query(`UPDATE calls SET transfer_status = 'dialing', transfer_started_at = now(), transfer_screened = $2 WHERE id = $1`, [callId, plan.whisper]);
      await event(c, call, 'transfer.dialing', { ringSeconds: plan.ringSeconds, whisper: plan.whisper });
      return plan.twiml;
    }
    // A conversation that finished, or one the relay has already fallen back on (callback recorded, holding line said).
    if (run?.status === 'ended' && run.outcome !== 'abandoned' && run.outcome !== 'error' && run.error === null) return twimlHangup();
    // The session ended with the conversation unfinished and the caller still on the line: never a dead line.
    await c.query('UPDATE calls SET relay_failed = true WHERE id = $1', [callId]);
    await event(c, call, 'relay.fallback', { steps: ['record_callback_request', 'holding_message'], by: 'session_ended' });
    return ladder(c, call, 'the live call could not carry on', true);
  });
}

const ABANDONED_BEFORE_DIAL = 'the caller asked for a person and hung up before they were put through';
async function abandonBeforeDial(c: pg.PoolClient, call: Pick<CallRow, 'id' | 'tenant_id' | 'project_id'>) {
  await c.query(`UPDATE calls SET transfer_status = 'abandoned' WHERE id = $1`, [call.id]);
  await event(c, call as CallRow, 'transfer.abandoned', { when: 'before_dial' });
  await addCallbackRequest(c, { tenantId: call.tenant_id, callId: call.id, reason: ABANDONED_BEFORE_DIAL });
}

/**
 * The agent's leg of the call, checked: the call this request names, on this provider, being put through now, and the
 * agent's leg a child of the caller's. A request that does not match ends the agent's leg, so no one is connected
 * unscreened; the mismatch is recorded once, so a live fault shows.
 */
async function agentLeg(c: pg.PoolClient, providerId: string, callId: string, params: Record<string, string>) {
  const call = await lockCall(c, providerId, callId, params.ParentCallSid).catch(() => null);
  if (call?.transfer_status === 'dialing') return call;
  if (!call) {
    const known = (await c.query('SELECT id, tenant_id, project_id, transfer_status FROM calls WHERE id = $1 AND provider_id = $2', [callId, providerId])).rows[0];
    if (known?.transfer_status === 'dialing') await eventOnce(c, known as CallRow, 'transfer.agent_leg_unmatched');
  }
  return null;
}

/**
 * The agent has picked up. Before being connected they hear why the call came to them and its ticket reference, and
 * press 1 to take it, so a voicemail answering is never taken for a person.
 */
export async function whisper(d: TransferDeps, providerId: string, callId: string, params: Record<string, string>): Promise<string> {
  return asInternal(d, async (c) => {
    const call = await agentLeg(c, providerId, callId, params);
    if (!call) return twimlHangup();
    const t = (await c.query(`SELECT id, trigger FROM tickets WHERE call_id = $1 AND kind = 'escalation' ORDER BY created_at DESC LIMIT 1`, [callId])).rows[0];
    await eventOnce(c, call, 'transfer.whispered', { ticket: t ? 'found' : 'none' });
    return twimlWhisper(whisperText({ trigger: t?.trigger ?? null, ticketId: t?.id ?? null }), transferUrl(d.baseUrl, providerId, 'accept', callId));
  });
}

/** The agent pressed a key after the whisper. Only 1 takes the call; the caller is then connected. */
export async function accept(d: TransferDeps, providerId: string, callId: string, params: Record<string, string>): Promise<string> {
  return asInternal(d, async (c) => {
    const call = await agentLeg(c, providerId, callId, params);
    if (!call || params.Digits !== '1') return twimlHangup();
    if (!call.transfer_accepted_at) {
      await c.query('UPDATE calls SET transfer_accepted_at = now() WHERE id = $1', [callId]);
      await event(c, call, 'transfer.accepted');
    }
    return twimlEmpty();
  });
}

/**
 * The dial to the agent has ended. Answered: the caller was put through, and the call ends when they are done. Not
 * answered, busy or failed: the callback ladder, with the request recorded once, however often Twilio asks.
 */
export async function afterDial(d: TransferDeps, providerId: string, callId: string, params: Record<string, string>): Promise<string> {
  return asInternal(d, async (c) => {
    const call = await lockCall(c, providerId, callId, params.CallSid);
    // A screened dial reached a person only if the agent pressed 1; otherwise a voicemail, or an agent who did not
    // take the call, ended it, and no one was reached.
    const dialled = dialOutcome(params.DialCallStatus);
    const outcome = dialled === 'answered' && call.transfer_screened !== false && !call.transfer_accepted_at ? 'unanswered' : dialled;
    const present = !GONE.includes(params.CallStatus ?? '');
    // How long the agent's leg lasted, for its cost. A leg that was never picked up is not billed; one that was (a
    // person, or a voicemail) is, so a missing duration there stays unknown and the call's cost waits for a person.
    // Only a status that says the leg never connected means no time; anything else without a duration is unknown.
    const seconds = dialSeconds(params.DialCallDuration) ?? (NEVER_CONNECTED.includes(params.DialCallStatus ?? '') ? 0 : null);
    if (call.transfer_status === 'dialing') {
      const next = outcome === 'answered' ? 'answered' : present ? outcome : 'abandoned';
      await c.query('UPDATE calls SET transfer_status = $2, transfer_seconds = $3 WHERE id = $1', [callId, next, seconds]);
      await event(c, call, `transfer.${next}`, next === 'abandoned' ? { when: 'while_ringing' } : {});
      await costIfEnded(c, callId);
      if (next === 'unanswered' || next === 'failed') return ladder(c, call, 'the caller asked for a person and no one answered', true);
      // The caller hung up while the agent's phone rang (or before the agent took the call): they asked for a person and
      // did not reach one, so a callback is recorded, once.
      if (next === 'abandoned') await addCallbackRequest(c, { tenantId: call.tenant_id, callId, reason: 'the caller asked for a person and hung up before anyone answered' });
      return twimlHangup();
    }
    // The call's end was reported first, while the dial was still under way (lesson L-029): its outcome stays unknown
    // and its callback stays recorded, but the agent's leg can now be costed.
    if (call.transfer_status === 'unknown' && seconds !== null) {
      await c.query('UPDATE calls SET transfer_seconds = $2 WHERE id = $1 AND transfer_seconds IS NULL', [callId, seconds]);
      await costIfEnded(c, callId);
      return twimlHangup();
    }
    // A retried request: say the same thing again, without recording the callback twice.
    if ((call.transfer_status === 'unanswered' || call.transfer_status === 'failed') && present) return ladder(c, call, '', false);
    return twimlHangup();
  });
}

/**
 * A person settles the agent leg's duration from the provider's records, for a call whose cost is waiting because Twilio
 * never reported the end of the dial. Only a leg that was dialled and has no duration yet can be set; it is audited.
 */
export async function settleAgentLeg(c: pg.PoolClient, actorId: string | null, callId: string, seconds: number) {
  const r = (await c.query('SELECT transfer_started_at, transfer_seconds, cost_status FROM calls WHERE id = $1 FOR UPDATE', [callId])).rows[0];
  if (!r) throw new AppError(404, 'Call not found.');
  if (!r.transfer_started_at) throw new AppError(409, 'This call never rang an agent, so it has no agent leg to settle.');
  if (r.transfer_seconds !== null) throw new AppError(409, 'This call\'s agent leg already has its duration.');
  // A call already priced (before agent legs were costed) is not changed after the fact: its cost record stands.
  if (['recorded', 'reconciled', 'variance', 'not_applicable'].includes(r.cost_status)) throw new AppError(409, 'This call is already priced, so its agent leg cannot be added now.');
  await c.query('UPDATE calls SET transfer_seconds = $2 WHERE id = $1', [callId, seconds]);
  await audit(c, actorId, 'transfer.agent_leg_settled', 'call', callId, { seconds });
}

/**
 * A call already over whose cost was waiting for its agent leg is costed now. Pricing never takes the transfer down
 * with it: if it fails outright, only the pricing is undone, the call stays waiting (the Control Tower shows a call
 * left unpriced), and the transfer's own record and callback stand.
 */
async function costIfEnded(c: pg.PoolClient, callId: string) {
  const r = (await c.query('SELECT ended_at, cost_status FROM calls WHERE id = $1', [callId])).rows[0];
  if (!r?.ended_at || r.cost_status !== 'pending') return;
  await c.query('SAVEPOINT transfer_cost');
  try { await costCall(c, null, callId); await c.query('RELEASE SAVEPOINT transfer_cost'); }
  catch { await c.query('ROLLBACK TO SAVEPOINT transfer_cost'); await audit(c, null, 'transfer.cost_failed', 'call', callId, {}); }
}

/**
 * The call has ended while its transfer was still dialling, and Twilio never said how the dial ended (our answer to it
 * may never have arrived). Whether anyone was reached is unknown, so it is recorded as unknown, never as a failure or
 * an answer, and a callback request is recorded: the caller asked for a person. Nothing is dialled again.
 */
export async function settleTransferOnEnd(c: pg.PoolClient, callId: string) {
  const call = (await c.query(
    `UPDATE calls SET transfer_status = 'unknown' WHERE id = $1 AND transfer_status = 'dialing' RETURNING id, tenant_id, project_id`, [callId])).rows[0] as CallRow | undefined;
  if (!call) {
    // The caller asked for a person and the call ended before Twilio asked what next (or that request never came):
    // no one was rung and no one was reached, so a callback is recorded, once. A call the relay already fell back on
    // has its callback.
    const waiting = (await c.query(
      `SELECT ca.id, ca.tenant_id, ca.project_id FROM calls ca JOIN workflow_runs r ON r.call_id = ca.id AND r.kind = 'live'
        WHERE ca.id = $1 AND ca.transfer_status IS NULL AND NOT ca.relay_failed
          AND r.status = 'ended' AND r.outcome = 'handoff_human' AND r.error IS NULL`, [callId])).rows[0] as CallRow | undefined;
    if (waiting) await abandonBeforeDial(c, waiting);
    return;
  }
  await addCallbackRequest(c, { tenantId: call.tenant_id, callId, reason: 'the caller asked for a person and the transfer did not finish' });
  await event(c, call, 'transfer.unknown');
}
