import type pg from 'pg';
import { AppError } from '../errors.js';
import { audit } from './audit.js';

export const OUTCOMES = ['contacted', 'rejected', 'wrong_number', 'third_party'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Calls that never reached the dialling stage: not attempts, and not the provider's doing. */
const NOT_DIALLED = `('did_locked', 'all_locked_for_contact', 'no_numbers', 'providers_unhealthy')`;

const validTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

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
  const row = (await c.query(
    `INSERT INTO outbound_outcomes (tenant_id, project_id, call_id, outcome, callback_day, callback_hour, callback_tz, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, call_id, outcome, callback_day, callback_hour, callback_tz, created_at`,
    [call.tenant_id, call.project_id, callId, e.outcome, e.callback?.day ?? null, e.callback?.hour ?? null, e.callback?.timeZone ?? null, actorId])).rows[0];
  await audit(c, actorId, 'outbound.outcome', 'call', callId, { outcome: e.outcome, callback: Boolean(e.callback) });
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
      WHERE ${where} AND l.callback_hour IS NOT NULL
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
