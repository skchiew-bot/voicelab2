import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { fromScaled, mulDiv, SCALE, toScaled } from '../money.js';
import { compare } from '../reconcile-rules.js';
import { twilioFetchCallUsage, type TwilioCreds } from '../telephony/twilio.js';
import { redactNumbers } from '../telephony/types.js';
import { audit } from './audit.js';
import { credentials, loadProvider, type CallDeps } from './calls.js';
import { perUsd } from './costs.js';
import { recordEvent } from './events.js';

export type ReconcileInput =
  | { source: 'provider_api' }
  | { source: 'manual'; reportedSeconds?: number; reportedCost?: string; currency?: string };

export type ReconcileResult =
  | { outcome: 'matched' | 'variance'; detail: string; alreadyReconciled?: false }
  | { outcome: 'pending'; detail: string }
  | { outcome: 'matched' | 'variance'; detail: string; alreadyReconciled: true };

const DEFAULT_TOLERANCE_PCT = 2;
const asInternal = <T>(d: CallDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.pool, { kind: 'internal' }, fn);

/**
 * Check one call's estimated cost against the provider's own figures. A match promotes the record to
 * "reconciled"; a difference is stored and flagged, and the estimate is left as it was.
 */
export async function reconcileCall(d: CallDeps, actorId: string | null, callId: string, input: ReconcileInput): Promise<ReconcileResult> {
  const tolerancePct = d.tolerancePct ?? DEFAULT_TOLERANCE_PCT;

  const ctx = await asInternal(d, async (c) => {
    const call = (await c.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
    if (!call) throw new AppError(404, 'Call not found.');
    if (!call.ended_at) throw new AppError(409, 'The call has not ended yet.');
    const prior = (await c.query('SELECT outcome, detail FROM call_reconciliations WHERE call_id = $1 ORDER BY id DESC LIMIT 1', [callId])).rows[0];
    if (prior?.outcome === 'matched') return { call, done: prior as { outcome: 'matched'; detail: string } };
    const cost = (await c.query(`SELECT id FROM call_costs WHERE call_id = $1 AND status = 'estimated'`, [callId])).rows[0];
    if (!cost) throw new AppError(409, 'This call has no estimated cost to check.');
    const provider = await loadProvider(c, call.provider_id);
    return { call, provider, costId: cost.id as string, done: null };
  });
  if (ctx.done) return { outcome: 'matched', detail: ctx.done.detail, alreadyReconciled: true };
  const { call, provider } = ctx;

  // What the provider reports. Network calls happen outside any transaction.
  let reportedSeconds: number | undefined; let reportedCost: string | undefined; let currency = 'USD';
  if (input.source === 'provider_api') {
    if (provider!.adapter_key !== 'twilio') {
      throw new AppError(400, 'Only Twilio has an automatic usage check so far. Send the provider\'s figures with source "manual" instead.');
    }
    try {
      const u = await twilioFetchCallUsage(credentials<TwilioCreds>(provider!, d.key), d.http, call.provider_call_id);
      if (u.state === 'pending') return { outcome: 'pending', detail: 'Twilio has not published this call\'s price yet. Try again later.' };
      reportedSeconds = u.seconds; reportedCost = u.cost; currency = u.currency;
    } catch (err) { throw new AppError(502, redactNumbers((err as Error).message)); }
  } else {
    if (input.reportedSeconds === undefined && input.reportedCost === undefined) {
      throw new AppError(400, 'Give the duration, the cost, or both, as the provider reported them.');
    }
    reportedSeconds = input.reportedSeconds; reportedCost = input.reportedCost; currency = (input.currency ?? 'USD').toUpperCase();
  }

  return asInternal(d, async (c) => {
    const lines = (await c.query(
      `SELECT sum(amount_usd) AS usd FROM call_cost_lines WHERE call_cost_id = $1 AND provider_id = $2`, [ctx.costId, call.provider_id])).rows[0];
    const ourCostUsd = lines.usd ?? '0.00000000';
    let reportedUsd: string | undefined;
    if (reportedCost !== undefined) {
      const fx = await perUsd(c, currency, call.started_at);
      reportedUsd = fromScaled(mulDiv(toScaled(reportedCost), SCALE, fx));
    }
    const verdict = compare({
      ourSeconds: Number(call.duration_seconds ?? 0), reportedSeconds, ourCostUsd, reportedCostUsd: reportedUsd, tolerancePct,
    });
    const outcome = verdict.matched ? 'matched' : 'variance';
    await c.query(
      `INSERT INTO call_reconciliations (call_id, provider_id, source, outcome, tolerance_pct, our_seconds, reported_seconds,
                                         our_cost_usd, reported_cost_usd, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [callId, call.provider_id, input.source, outcome, tolerancePct, call.duration_seconds, reportedSeconds ?? null,
        ourCostUsd, reportedUsd ?? null, verdict.detail],
    );
    if (verdict.matched) {
      // Promote: a second record for the call, same lines, no second draw of credits.
      const n = (await c.query(
        `INSERT INTO call_costs (call_id, tenant_id, project_id, direction, occurred_at, status, total_usd, myr_per_usd,
                                 total_myr, credits_drawn, credit_value_usd, margin_usd)
         SELECT call_id, tenant_id, project_id, direction, occurred_at, 'reconciled', total_usd, myr_per_usd,
                total_myr, credits_drawn, credit_value_usd, margin_usd FROM call_costs WHERE id = $1 RETURNING id`, [ctx.costId])).rows[0];
      await c.query(
        `INSERT INTO call_cost_lines (call_cost_id, provider_id, charging_version_id, component, billing_line, unit, quantity,
                                      billed_seconds, rate, currency, burst_multiplier, amount, per_usd, amount_usd)
         SELECT $2, provider_id, charging_version_id, component, billing_line, unit, quantity, billed_seconds, rate, currency,
                burst_multiplier, amount, per_usd, amount_usd FROM call_cost_lines WHERE call_cost_id = $1`, [ctx.costId, n.id]);
    }
    await c.query('UPDATE calls SET cost_status = $2 WHERE id = $1', [callId, verdict.matched ? 'reconciled' : 'variance']);
    await recordEvent(c, {
      tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId,
      type: verdict.matched ? 'call.cost_reconciled' : 'call.cost_variance', payload: { source: input.source, detail: verdict.detail },
    });
    await audit(c, actorId, 'call_cost.reconcile', 'call', callId, { outcome, source: input.source });
    return { outcome, detail: verdict.detail } as ReconcileResult;
  });
}

/** Check recently finished Twilio calls that have not been checked yet. Calls Twilio has not priced yet are left for next time. */
export async function reconcileSweep(d: CallDeps, actorId: string | null, o: { olderThanMinutes: number; limit: number }) {
  const due = await asInternal(d, async (c) =>
    (await c.query(
      `SELECT ca.id FROM calls ca JOIN providers p ON p.id = ca.provider_id
        WHERE p.adapter_key = 'twilio' AND ca.cost_status = 'recorded' AND ca.ended_at < now() - ($1 || ' minutes')::interval
          AND ca.provider_call_id IS NOT NULL
        ORDER BY ca.ended_at LIMIT $2`, [o.olderThanMinutes, o.limit])).rows.map((r) => r.id as string));
  const tally = { checked: due.length, matched: 0, variance: 0, pending: 0, failed: 0 };
  for (const id of due) {
    try {
      const r = await reconcileCall(d, actorId, id, { source: 'provider_api' });
      tally[r.outcome] += 1;
    } catch { tally.failed += 1; }
  }
  return tally;
}

export const listReconciliations = async (c: pg.PoolClient, callId: string) =>
  (await c.query(
    `SELECT id, source, outcome, tolerance_pct, our_seconds, reported_seconds, our_cost_usd, reported_cost_usd, detail, created_at
       FROM call_reconciliations WHERE call_id = $1 ORDER BY id`, [callId])).rows;
