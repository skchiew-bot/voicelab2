import type pg from 'pg';
import { AppError } from '../errors.js';
import { audit } from './audit.js';

import { canonicalTimeZone, CONTACT_OUTCOMES, validTimeZone, type CallbackTime, type ContactOutcome } from '../workflows/definition.js';

export const OUTCOMES = CONTACT_OUTCOMES;
export type Outcome = ContactOutcome;
/** Calls that never reached the dialling stage: not attempts, and not the provider's doing. */
const NOT_DIALLED = `('did_locked', 'all_locked_for_contact', 'no_numbers', 'providers_unhealthy')`;


/**
 * Say how an answered outbound call turned out, and, if the person asked to be called back, when. The latest
 * statement for a call is the current one; earlier ones stay. Nothing here holds a phone number.
 */
export async function recordOutcome(
  c: pg.PoolClient, actorId: string | null, callId: string,
  e: { outcome: Outcome; callback?: { day: number; hour: number; timeZone: string } },
) {
  const call = (await c.query('SELECT id, tenant_id, project_id, direction, status FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call) throw new AppError(404, 'Call not found.');
  if (call.direction !== 'outbound') throw new AppError(409, 'Outcomes are for outbound calls.');
  if (call.status !== 'completed') throw new AppError(409, 'Only an answered call (one that completed) has an outcome. Unanswered and failed calls are counted from their status.');
  if (e.callback && !validTimeZone(e.callback.timeZone)) throw new AppError(400, 'That is not a time zone name, e.g. Asia/Kuala_Lumpur.');
  if (e.callback && e.outcome === 'wrong_number') throw new AppError(400, 'A wrong number has no callback time.');
  await lockOutcomes(c, callId);
  const row = (await c.query(
    `INSERT INTO outbound_outcomes (tenant_id, project_id, call_id, outcome, callback_day, callback_hour, callback_tz, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, call_id, outcome, callback_day, callback_hour, callback_tz, created_at`,
    [call.tenant_id, call.project_id, callId, e.outcome, e.callback?.day ?? null, e.callback?.hour ?? null, e.callback ? canonicalTimeZone(e.callback.timeZone) : null, actorId])).rows[0];
  await audit(c, actorId, 'outbound.outcome', 'call', callId, { outcome: e.outcome, callback: Boolean(e.callback) });
  return row;
}

/**
 * Statements about one call's outcome are made one at a time, so a workflow's can see whether a person has spoken. A lock
 * of its own: the workflow's statement is made while its run's row is held, and the call's row is taken before the run's
 * everywhere else, so taking the call's row here could deadlock.
 */
const lockOutcomes = (c: pg.PoolClient, callId: string) => c.query(`SELECT pg_advisory_xact_lock(hashtext('outbound_outcome:' || $1))`, [callId]);

/**
 * A live call's workflow ended at a node that says how the call turned out: that is recorded as the call's outcome, in
 * the same step that ends the run, with no person named. Only an outbound call has one. A person can still correct it,
 * and the latest statement is the current one; once a person has spoken, the workflow records nothing. The call may not have completed yet (its end is reported after the
 * workflow's); the analytics count an outcome only once the call has.
 */
export async function recordWorkflowOutcome(c: pg.PoolClient, e: { callId: string; runId: string; contact: Outcome; callback?: CallbackTime }) {
  const call = (await c.query('SELECT tenant_id, project_id, direction FROM calls WHERE id = $1', [e.callId])).rows[0];
  if (!call || call.direction !== 'outbound') return null;
  // A person's statement is never replaced by the workflow's, even one that lands after it (a reply still being applied
  // when the call ended and someone classified it).
  await lockOutcomes(c, e.callId);
  if ((await c.query('SELECT 1 FROM outbound_outcomes WHERE call_id = $1 AND recorded_by IS NOT NULL LIMIT 1', [e.callId])).rowCount) return null;
  const row = (await c.query(
    `INSERT INTO outbound_outcomes (tenant_id, project_id, call_id, outcome, callback_day, callback_hour, callback_tz) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [call.tenant_id, call.project_id, e.callId, e.contact, e.callback?.day ?? null, e.callback?.hour ?? null, e.callback?.timeZone ?? null])).rows[0];
  await audit(c, null, 'outbound.outcome', 'call', e.callId, { outcome: e.contact, callback: Boolean(e.callback), source: 'workflow', run: e.runId });
  return row;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

/**
 * Outbound results over a period. A call is an attempt once it has been dialled and finished. Contact rate is people
 * actually reached out of attempts; answered calls nobody has classified yet are shown, not guessed.
 */
export async function outboundAnalytics(c: pg.PoolClient, e: { tenantId?: string; projectId?: string; from: Date; to: Date }) {
  const params = [e.tenantId ?? null, e.projectId ?? null, e.from, e.to];
  const where = `c.direction = 'outbound' AND ($1::uuid IS NULL OR c.tenant_id = $1) AND ($2::uuid IS NULL OR c.project_id = $2) AND c.started_at >= $3 AND c.started_at < $4`;
  const t = (await c.query(
    `WITH latest AS (SELECT DISTINCT ON (call_id) call_id, outcome FROM outbound_outcomes ORDER BY call_id, id DESC)
     SELECT count(*) FILTER (WHERE c.status = 'blocked')::int AS blocked,
            count(*) FILTER (WHERE c.status = 'failed' AND coalesce(c.end_reason, '') IN ${NOT_DIALLED})::int AS no_caller_id,
            count(*) FILTER (WHERE c.status IN ('dialing', 'ringing', 'in_progress'))::int AS in_flight,
            count(*) FILTER (WHERE c.status = 'unanswered')::int AS no_answer,
            count(*) FILTER (WHERE c.status = 'failed' AND coalesce(c.end_reason, '') NOT IN ${NOT_DIALLED})::int AS unreachable,
            count(*) FILTER (WHERE c.status = 'completed')::int AS answered,
            count(*) FILTER (WHERE c.status = 'completed' AND l.outcome = 'contacted')::int AS contacted,
            count(*) FILTER (WHERE c.status = 'completed' AND l.outcome = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE c.status = 'completed' AND l.outcome = 'wrong_number')::int AS wrong_number,
            count(*) FILTER (WHERE c.status = 'completed' AND l.outcome = 'third_party')::int AS third_party,
            count(*) FILTER (WHERE c.status = 'completed' AND l.outcome IS NULL)::int AS unclassified
       FROM calls c LEFT JOIN latest l ON l.call_id = c.id WHERE ${where}`, params)).rows[0];
  const attempts = t.no_answer + t.unreachable + t.answered;
  const slots = (await c.query(
    `WITH latest AS (SELECT DISTINCT ON (call_id) call_id, callback_day, callback_hour, callback_tz FROM outbound_outcomes ORDER BY call_id, id DESC)
     SELECT l.callback_day AS day, l.callback_hour AS hour, l.callback_tz AS time_zone, count(*)::int AS requests
       FROM calls c JOIN latest l ON l.call_id = c.id
      WHERE ${where} AND c.status = 'completed' AND l.callback_hour IS NOT NULL   -- counted once the call has completed, as outcomes are
      GROUP BY 1, 2, 3 ORDER BY requests DESC, day, hour, time_zone LIMIT 10`, params)).rows;
  return {
    period: { from: e.from.toISOString(), to: e.to.toISOString() },
    notDialled: { blocked: t.blocked, noCallerId: t.no_caller_id },
    inFlight: t.in_flight,
    attempts,
    outcomes: { contacted: t.contacted, rejected: t.rejected, wrongNumber: t.wrong_number, thirdParty: t.third_party, unclassified: t.unclassified, noAnswer: t.no_answer, unreachable: t.unreachable },
    rates: { contactPercent: pct(t.contacted, attempts), answerPercent: pct(t.answered, attempts) },
    bestCallbackTimes: slots,
  };
}
