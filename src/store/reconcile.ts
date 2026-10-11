import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { fromScaled, mulDiv, SCALE, toScaled } from '../money.js';
import { compare } from '../reconcile-rules.js';
import type { TelnyxCostReport } from '../telephony/telnyx.js';
import { twilioFetchCallUsage, type TwilioCreds } from '../telephony/twilio.js';
import { redactNumbers } from '../telephony/types.js';
import { audit } from './audit.js';
import { credentials, loadProvider, type CallDeps, type ProviderRow } from './calls.js';
import { perUsd } from './costs.js';
import { recordEvent } from './events.js';

export type ReconcileInput =
  | { source: 'provider_api' }
  | { source: 'manual'; reportedSeconds?: number; reportedCost: string; currency?: string };

export type ReconcileResult =
  | { outcome: 'matched' | 'variance' | 'unchecked'; detail: string; alreadyReconciled?: false }
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
    // A call put through to a person has a second leg at the provider (ours to the agent), costed with it: checked with it.
    const agentLeg = (await c.query(`SELECT 1 FROM call_cost_lines WHERE call_cost_id = $1 AND leg = 'agent' LIMIT 1`, [cost.id])).rowCount! > 0;
    return { call, provider, costId: cost.id as string, agentLeg, done: null };
  });
  if (ctx.done) return { outcome: 'matched', detail: ctx.done.detail, alreadyReconciled: true };
  const { call, provider } = ctx;

  // What the provider reports. Network calls happen outside any transaction. A report can be in more than one currency
  // (Telnyx prices each part of a call on its own), so the caller's leg is a list of amounts, each turned into US dollars.
  let reportedSeconds: number | undefined; let reported: { cost: string; currency: string }[] | undefined;
  // Twilio and a person report the call's length; Telnyx reports the seconds it billed, so ours are our billed seconds.
  let secondsBilled = false;
  // The agent's leg as Twilio reports it, looked up by its own id. A costed leg with no id to look it up by (one a person
  // settled by hand) cannot be checked automatically and is left for a person, never passed on the caller's leg alone.
  let leg: { seconds: number; cost: string; currency: string } | null = null;
  let legUncheckable = false;
  if (input.source === 'provider_api' && provider!.adapter_key === 'telnyx') {
    // Telnyx sends each call's cost in a signed webhook rather than answering a question about it: read the latest report
    // that priced the call (a later "could not price it" does not take a price away).
    const r = await asInternal(d, async (c) => (await c.query(
      `SELECT status, billed_seconds, amounts FROM provider_cost_reports WHERE call_id = $1 AND provider_id = $2 ORDER BY status = 'ready' DESC, id DESC LIMIT 1`,
      [callId, call.provider_id])).rows[0]);
    if (!r) return { outcome: 'pending', detail: 'Telnyx has not sent this call\'s cost yet. It is checked when it arrives.' };
    if (r.status === 'error') return { outcome: 'pending', detail: 'Telnyx reported that it could not price this call. It is checked again if Telnyx sends its cost.' };
    // Telnyx has no leg of ours to an agent (transfers run on Twilio); a costed one could not be checked here.
    if (ctx.agentLeg) legUncheckable = true;
    reportedSeconds = r.billed_seconds === null ? undefined : Number(r.billed_seconds);
    reported = r.amounts as { cost: string; currency: string }[];
    secondsBilled = true;
  } else if (input.source === 'provider_api') {
    if (provider!.adapter_key !== 'twilio') {
      throw new AppError(400, 'Only Twilio and Telnyx have an automatic usage check so far. Send the provider\'s figures with source "manual" instead.');
    }
    if (!call.provider_call_id) throw new AppError(400, 'This call never got an id from the provider, so there is nothing to look up.');
    try {
      const u = await twilioFetchCallUsage(credentials<TwilioCreds>(provider!, d.key), d.http, call.provider_call_id);
      if (u.state === 'pending') return { outcome: 'pending', detail: 'Twilio has not published this call\'s price yet. Try again later.' };
      reportedSeconds = u.seconds; reported = [{ cost: u.cost, currency: u.currency }];
      if (ctx.agentLeg && !call.transfer_leg_sid) legUncheckable = true;
      else if (ctx.agentLeg) {
        const l = await twilioFetchCallUsage(credentials<TwilioCreds>(provider!, d.key), d.http, call.transfer_leg_sid);
        if (l.state === 'pending') return { outcome: 'pending', detail: 'Twilio has not published the price of the leg to the agent yet. Try again later.' };
        leg = { seconds: l.seconds, cost: l.cost, currency: l.currency };
      }
    } catch (err) { throw new AppError(502, redactNumbers((err as Error).message)); }
  } else {
    // A duration alone cannot show the rate was right, so the provider's price is required.
    if (input.reportedCost === undefined || input.reportedCost === '') {
      throw new AppError(400, 'Give the cost the provider charged (and, if you have it, the duration).');
    }
    reportedSeconds = input.reportedSeconds; reported = [{ cost: input.reportedCost, currency: (input.currency ?? 'USD').toUpperCase() }];
  }

  return asInternal(d, async (c): Promise<ReconcileResult> => {
    // Two checks of one call must take turns. Whoever gets here second sees the first one's result.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reconcile:${callId}`]);
    const done = (await c.query(
      `SELECT detail FROM call_reconciliations WHERE call_id = $1 AND outcome = 'matched' ORDER BY id DESC LIMIT 1`, [callId])).rows[0];
    if (done) return { outcome: 'matched', detail: done.detail, alreadyReconciled: true };
    // Our cost of each leg: the provider's figures cover both (looked up for each leg, or entered by hand as the total).
    // The speech relay is billed as its own item, outside the call's price, so its lines are not compared here.
    const byLeg = new Map((await c.query(
      `SELECT leg, sum(amount_usd) AS usd FROM call_cost_lines WHERE call_cost_id = $1 AND provider_id = $2 AND billing_line <> 'relay' GROUP BY leg`, [ctx.costId, call.provider_id])).rows
      .map((r) => [r.leg as string, toScaled(r.usd)]));
    const ourCallerUsd = byLeg.get('caller') ?? 0n; const ourAgentUsd = byLeg.get('agent') ?? 0n;
    const ourCostUsd = fromScaled(ourCallerUsd + ourAgentUsd);
    // Each leg is turned into US dollars on its own, since Twilio may price them in different currencies.
    const toUsd = async (amount: string, cur: string) => mulDiv(toScaled(amount), SCALE, await perUsd(c, cur, call.started_at));
    // A report with no amounts (Telnyx's total of nothing) says the call cost nothing.
    let callerUsd: bigint | undefined = reported === undefined ? undefined : 0n;
    for (const a of reported ?? []) callerUsd = callerUsd! + await toUsd(a.cost, a.currency);
    const legUsd = leg ? await toUsd(leg.cost, leg.currency) : 0n;
    const reportedUsd = callerUsd === undefined ? undefined : fromScaled(callerUsd + legUsd);
    // Our billed seconds: the longest billed line of the caller's leg at this provider, as Telnyx reports the longest of its parts.
    const ourBilled = secondsBilled ? (await c.query(
      `SELECT max(billed_seconds) AS s FROM call_cost_lines WHERE call_cost_id = $1 AND provider_id = $2 AND leg = 'caller' AND billing_line <> 'relay'`,
      [ctx.costId, call.provider_id])).rows[0].s : null;
    // With no billed seconds of our own to set against Telnyx's, only the cost is compared.
    if (secondsBilled && ourBilled === null) reportedSeconds = undefined;
    const callerSeconds = secondsBilled && ourBilled !== null ? Number(ourBilled) : Number(call.duration_seconds ?? 0); const agentSeconds = ctx.agentLeg ? Number(call.transfer_seconds ?? 0) : 0;
    const ourSeconds = callerSeconds + agentSeconds;
    const theirSeconds = legUncheckable || reportedSeconds === undefined ? undefined : reportedSeconds + (leg?.seconds ?? 0);
    let verdict: { matched: boolean; detail: string };
    if (legUncheckable) {
      verdict = { matched: false, detail: 'The leg to the agent has no Twilio id to look it up by, so it cannot be checked automatically. Check both legs by hand (manual figures are the total for both legs).' };
    } else if (leg) {
      // Looked up leg by leg: each is held to the tolerance on its own, so an error on one cannot hide behind the other.
      const a = compare({ ourSeconds: callerSeconds, reportedSeconds, ourCostUsd: fromScaled(ourCallerUsd), reportedCostUsd: callerUsd === undefined ? undefined : fromScaled(callerUsd), tolerancePct });
      const b = compare({ ourSeconds: agentSeconds, reportedSeconds: leg.seconds, ourCostUsd: fromScaled(ourAgentUsd), reportedCostUsd: fromScaled(legUsd), tolerancePct });
      verdict = { matched: a.matched && b.matched, detail: `caller's leg: ${a.detail}. Agent's leg: ${b.detail}` };
    } else {
      verdict = compare({ ourSeconds, reportedSeconds: theirSeconds, ourCostUsd, reportedCostUsd: reportedUsd, tolerancePct });
    }
    const outcome = legUncheckable ? 'unchecked' : verdict.matched ? 'matched' : 'variance';
    await c.query(
      `INSERT INTO call_reconciliations (call_id, provider_id, source, outcome, tolerance_pct, our_seconds, reported_seconds,
                                         our_cost_usd, reported_cost_usd, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [callId, call.provider_id, input.source, outcome, tolerancePct, ourSeconds, theirSeconds ?? null,
        ourCostUsd, legUncheckable ? null : reportedUsd ?? null, verdict.detail],
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
                                      billed_seconds, rate, currency, burst_multiplier, amount, per_usd, amount_usd, leg)
         SELECT $2, provider_id, charging_version_id, component, billing_line, unit, quantity, billed_seconds, rate, currency,
                burst_multiplier, amount, per_usd, amount_usd, leg FROM call_cost_lines WHERE call_cost_id = $1`, [ctx.costId, n.id]);
    }
    await c.query('UPDATE calls SET cost_status = $2 WHERE id = $1', [callId, verdict.matched ? 'reconciled' : outcome]);
    await recordEvent(c, {
      tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId,
      type: verdict.matched ? 'call.cost_reconciled' : `call.cost_${outcome}`, payload: { source: input.source, detail: verdict.detail },
    });
    await audit(c, actorId, 'call_cost.reconcile', 'call', callId, { outcome, source: input.source });
    return { outcome, detail: verdict.detail };
  });
}

const MAX_SWEEP_ATTEMPTS = 8;

/**
 * Keep a verified Telnyx cost report against its call, once (a retried delivery changes nothing), then check the call
 * straight away if its cost is already recorded. A report that lands before the call is costed is checked by the sweep
 * once it is (lesson L-029). A failed check is left for the sweep: it never fails the webhook, which would only be retried.
 */
export async function recordTelnyxCost(d: CallDeps, provider: ProviderRow, r: TelnyxCostReport): Promise<'recorded' | 'duplicate' | 'unknown_call'> {
  const callId = await asInternal(d, async (c) => {
    const fresh = await c.query('INSERT INTO webhook_events (provider_id, event_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [provider.id, r.key]);
    if (!fresh.rowCount) return 'duplicate' as const;
    // Our call id rides along as client_state; a call is matched by it only when it is this provider's.
    const byHint = r.callIdHint && /^[0-9a-f-]{36}$/.test(r.callIdHint)
      ? (await c.query('SELECT id, tenant_id, project_id FROM calls WHERE id = $1 AND provider_id = $2', [r.callIdHint, provider.id])).rows[0] : undefined;
    const call = byHint ?? (await c.query('SELECT id, tenant_id, project_id FROM calls WHERE provider_id = $1 AND provider_call_id = $2', [provider.id, r.providerCallId])).rows[0];
    if (!call) { await audit(c, null, 'webhook.unknown_call', 'provider', provider.id, { kind: 'cost' }); return 'unknown_call' as const; }
    await c.query(
      `INSERT INTO provider_cost_reports (provider_id, call_id, status, billed_seconds, amounts, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [provider.id, call.id, r.status, r.status === 'ready' ? r.billedSeconds : null, JSON.stringify(r.status === 'ready' ? r.amounts : []), r.occurredAt]);
    await recordEvent(c, { tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId: call.id, type: 'call.cost_reported', payload: { status: r.status } });
    return { id: call.id as string, costed: (await c.query(`SELECT cost_status FROM calls WHERE id = $1`, [call.id])).rows[0].cost_status === 'recorded' };
  });
  if (typeof callId === 'string') return callId;
  if (callId.costed) { try { await reconcileCall(d, null, callId.id, { source: 'provider_api' }); } catch { /* the sweep tries again */ } }
  return 'recorded';
}

/**
 * Check finished Twilio calls, and Telnyx calls whose cost Telnyx has sent, that have not been checked yet. Each try is recorded: calls tried longest
 * ago go first, and a call that has been tried too often is left for a person, so calls Twilio will never
 * price (it does not price calls that never connected) cannot crowd out newer ones.
 */
export async function reconcileSweep(d: CallDeps, actorId: string | null, o: { olderThanMinutes: number; limit: number }) {
  const due = await asInternal(d, async (c) =>
    (await c.query(
      `SELECT ca.id FROM calls ca JOIN providers p ON p.id = ca.provider_id
        WHERE (p.adapter_key = 'twilio'
               -- Telnyx is not asked: a call is checked once its cost report has arrived.
               OR (p.adapter_key = 'telnyx' AND EXISTS (SELECT 1 FROM provider_cost_reports r WHERE r.call_id = ca.id AND r.provider_id = ca.provider_id)))
          AND ca.cost_status = 'recorded' AND ca.provider_call_id IS NOT NULL
          AND ca.duration_seconds > 0 AND ca.reconcile_attempts < $3
          AND ca.ended_at < now() - ($1 || ' minutes')::interval
          AND (ca.reconcile_attempted_at IS NULL OR ca.reconcile_attempted_at < now() - ($1 || ' minutes')::interval)
        ORDER BY ca.reconcile_attempted_at NULLS FIRST, ca.ended_at LIMIT $2`, [o.olderThanMinutes, o.limit, MAX_SWEEP_ATTEMPTS])).rows.map((r) => r.id as string));
  const tally = { checked: due.length, matched: 0, variance: 0, unchecked: 0, pending: 0, failed: 0 };
  for (const id of due) {
    try {
      const r = await reconcileCall(d, actorId, id, { source: 'provider_api' });
      tally[r.outcome] += 1;
    } catch { tally.failed += 1; }
    await asInternal(d, (c) => c.query(
      'UPDATE calls SET reconcile_attempts = reconcile_attempts + 1, reconcile_attempted_at = now() WHERE id = $1', [id]));
  }
  return tally;
}

export const listReconciliations = async (c: pg.PoolClient, callId: string) =>
  (await c.query(
    `SELECT id, source, outcome, tolerance_pct, our_seconds, reported_seconds, our_cost_usd, reported_cost_usd, detail, created_at
       FROM call_reconciliations WHERE call_id = $1 ORDER BY id`, [callId])).rows;
