/**
 * The Control Tower's panels beyond the first screen: stitching, deliverability, concurrency, journey and QA, the
 * learning loop, the business modules and funding runway. Everything here is read from the event log, the ledgers and
 * the registries; nothing is stored. Each panel is worked out on its own, so one that fails is reported as unavailable
 * and the others still show (lesson L-006). Money stays exact (lesson L-004), and a figure that cannot be known is
 * null, never 0 (lesson L-005).
 */
import type pg from 'pg';
import { fromScaled, toScaled } from '../money.js';
import { appointmentSummary } from './appointments.js';
import { caseSummary } from './cases.js';
import { providerLoad } from './concurrency.js';
import { learningSummary } from './learning.js';
import { outboundAnalytics } from './outbound.js';

const BURN_DAYS = 7;

/** A share as a percentage with two decimals, worked out in whole numbers; null when there is nothing to share. */
export function percent(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  const bp = Math.round((part * 10_000) / whole);          // basis points: counts, not money, so this is exact enough
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}

/**
 * Days of funding left at the recent rate of spend, to one decimal place (rounded down), or null when there has been
 * no spend to measure. A balance at or below zero has no days left.
 */
export function runwayDays(balance: string, spent: string, days: number): string | null {
  const b = toScaled(balance); const s = toScaled(spent);
  if (s <= 0n) return null;
  if (b <= 0n) return '0.0';
  const tenths = (b * BigInt(days) * 10n) / s;               // balance ÷ (spent ÷ days), in tenths of a day, rounded down
  return `${tenths / 10n}.${tenths % 10n}`;
}

async function stitching(c: pg.PoolClient) {
  // What was said on real and test calls (not rehearsals) in the last 7 days, credited to the workflow that spoke it
  // (a child workflow's lines are its own): characters synthesised and characters played from recordings.
  const base = `FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE s.type = 'say' AND r.kind IN ('live', 'test') AND s.created_at > now() - interval '7 days'`;
  const total = (await c.query(
    `SELECT coalesce(sum((s.payload->>'synthChars')::bigint), 0)::text AS synth, coalesce(sum((s.payload->>'recordedChars')::bigint), 0)::text AS recorded ${base}`)).rows[0];
  const rows = (await c.query(
    `SELECT s.workflow, r.tenant_id, t.name AS tenant, w.id AS workflow_id,
            coalesce(sum((s.payload->>'synthChars')::bigint), 0)::text AS synth, coalesce(sum((s.payload->>'recordedChars')::bigint), 0)::text AS recorded
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN workflows w ON w.tenant_id = r.tenant_id AND w.name = s.workflow
      WHERE s.type = 'say' AND r.kind IN ('live', 'test') AND s.created_at > now() - interval '7 days'
      GROUP BY s.workflow, r.tenant_id, t.name, w.id
      ORDER BY coalesce(sum((s.payload->>'synthChars')::bigint), 0) + coalesce(sum((s.payload->>'recordedChars')::bigint), 0) DESC, s.workflow LIMIT 20`)).rows;
  const workflows = rows.map((r) => {
    const synth = Number(r.synth); const recorded = Number(r.recorded);
    return { workflowId: (r.workflow_id as string | null), workflow: r.workflow as string, tenant: r.tenant as string, synthChars: synth, recordedChars: recorded, recordedPercent: percent(recorded, synth + recorded) };
  });
  // The totals cover every workflow, not just the twenty busiest listed.
  const synth = Number(total.synth); const recorded = Number(total.recorded);
  return { synthChars: synth, recordedChars: recorded, recordedPercent: percent(recorded, synth + recorded), workflows };
}

async function deliverability(c: pg.PoolClient) {
  const pool = (await c.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'retired')::int AS retired FROM phone_numbers`)).rows[0];
  const failures = (await c.query(
    `SELECT reason, count(*)::int AS n, count(DISTINCT phone_number_id)::int AS numbers FROM did_failures WHERE created_at > now() - interval '7 days' GROUP BY reason ORDER BY n DESC`)).rows;
  // The same counting as the Outbound screen, so the two never disagree: a call's latest outcome only, attempts are
  // finished dials, and answered calls nobody has classified are shown as such, never as "not contacted".
  const now = new Date();
  const a = await outboundAnalytics(c, { from: new Date(now.getTime() - 7 * 86_400_000), to: now });
  return { pool: { active: pool.active as number, retired: pool.retired as number }, failures, attempts: a.attempts, inFlight: a.inFlight, notDialled: a.notDialled, outcomes: a.outcomes, rates: a.rates };
}

async function concurrency(c: pg.PoolClient) {
  const providers = (await c.query(`SELECT id, name FROM providers WHERE kind = 'telephony' AND status = 'active' ORDER BY name`)).rows;
  const load = await providerLoad(c, providers.map((p) => p.id));
  const burst = (await c.query(`SELECT provider_id, count(*)::int AS n FROM calls WHERE burst AND started_at > now() - interval '24 hours' GROUP BY provider_id`)).rows;
  const deferred = (await c.query(`SELECT count(*)::int AS n FROM failover_events WHERE scope = 'telephony' AND trigger = 'capacity' AND at > now() - interval '24 hours'`)).rows[0].n as number;
  const tenants = (await c.query(
    `SELECT t.id, t.name, e.inbound_channels + e.extra_channels AS channels,
            (SELECT count(*)::int FROM calls k WHERE k.tenant_id = t.id AND k.direction = 'inbound' AND k.status IN ('ringing', 'in_progress')) AS active,
            (SELECT count(*)::int FROM calls k WHERE k.tenant_id = t.id AND k.status = 'queued') AS queued
       FROM tenant_entitlements e JOIN tenants t ON t.id = e.tenant_id ORDER BY t.name`)).rows;
  return {
    providers: providers.map((p) => {
      const l = load.get(p.id)!;
      return { providerId: p.id as string, provider: p.name as string, active: l.active, ceiling: l.ceiling, usedPercent: l.ceiling === null ? null : percent(l.active, l.ceiling), burst24h: burst.find((b) => b.provider_id === p.id)?.n ?? 0 };
    }),
    deferred24h: deferred,
    tenants: tenants.map((t) => ({ tenantId: t.id as string, tenant: t.name as string, channels: t.channels as number, active: t.active as number, queued: t.queued as number })),
  };
}

async function journeyQa(c: pg.PoolClient) {
  const qa = (await c.query(
    `SELECT count(DISTINCT run_id)::int AS scored, count(*)::int AS scores, round(avg(score), 2)::text AS average,
            count(*) FILTER (WHERE score < 50)::int AS b0, count(*) FILTER (WHERE score >= 50 AND score < 70)::int AS b50,
            count(*) FILTER (WHERE score >= 70 AND score < 90)::int AS b70, count(*) FILTER (WHERE score >= 90)::int AS b90
       FROM qa_scores WHERE created_at > now() - interval '7 days'`)).rows[0];
  const escalations = (await c.query(
    `SELECT trigger, count(*)::int AS n FROM tickets WHERE kind = 'escalation' AND created_at > now() - interval '7 days' GROUP BY trigger ORDER BY n DESC`)).rows;
  const faults = (await c.query(`SELECT count(*)::int AS n FROM calls c WHERE c.fault AND NOT EXISTS (SELECT 1 FROM fault_acks a WHERE a.call_id = c.id)`)).rows[0].n as number;
  // How callers sounded, day by day: the average sentiment of the turns that were read (sensitive answers never are).
  const sentiment = (await c.query(
    `SELECT to_char(date_trunc('day', s.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS turns,
            round(avg((s.payload->'analysis'->>'sentiment')::numeric), 2)::text AS average,   -- null when no turn that day carried a reading
            count(*) FILTER (WHERE (s.payload->'analysis'->>'severe')::boolean)::int AS severe
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE s.type = 'heard' AND r.kind IN ('live', 'test') AND s.payload ? 'analysis' AND s.created_at > now() - interval '7 days'
      GROUP BY 1 ORDER BY 1`)).rows;
  return {
    qa: { scored: qa.scored as number, scores: qa.scores as number, average: qa.scores > 0 ? (qa.average as string) : null, distribution: [
      { band: 'below 50', n: qa.b0 as number }, { band: '50 to 69', n: qa.b50 as number }, { band: '70 to 89', n: qa.b70 as number }, { band: '90 and above', n: qa.b90 as number }] },
    escalations, unacknowledgedFaults: faults, sentiment,
  };
}

async function learning(c: pg.PoolClient) {
  const tenants = (await c.query('SELECT DISTINCT p.tenant_id, t.name FROM promotions p JOIN tenants t ON t.id = p.tenant_id ORDER BY t.name')).rows;
  const total = { inReview: 0, approved: 0, promoted: 0, demoted: 0, rejected: 0 };
  for (const t of tenants) {
    const s = await learningSummary(c, t.tenant_id);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
  }
  const demotions = (await c.query(
    `SELECT count(*) FILTER (WHERE coalesce((detail->>'forced')::boolean, false) = false)::int AS drift, count(*) FILTER (WHERE (detail->>'forced')::boolean)::int AS forced
       FROM promotion_events WHERE kind = 'demoted' AND created_at > now() - interval '7 days'`)).rows[0];
  return { ...total, driftDemotions7d: demotions.drift as number, forcedDemotions7d: demotions.forced as number };
}

async function modules(c: pg.PoolClient) {
  const cases = await caseSummary(c);
  const broken = (await c.query(`SELECT count(*)::int AS n FROM promises WHERE status = 'broken' AND settled_at > now() - interval '7 days'`)).rows[0].n as number;
  const appointments = await appointmentSummary(c);
  const cascades = (await c.query(`SELECT count(DISTINCT appointment_id)::int AS moved FROM appointment_events WHERE kind = 'delayed' AND at > now() - interval '7 days'`)).rows[0].moved as number;
  return { cases: { ...cases, brokenPromises7d: broken }, appointments: { ...appointments, movedByDelays7d: cascades } };
}

async function funding(c: pg.PoolClient) {
  const balances = (await c.query(
    `SELECT f.provider_id, p.name, p.status, f.currency, sum(f.amount)::text AS balance, max(f.created_at) AS recorded_at
       FROM provider_funding_entries f JOIN providers p ON p.id = f.provider_id GROUP BY f.provider_id, p.name, p.status, f.currency ORDER BY p.name, f.currency`)).rows;
  // What each provider charged in the last 7 days, in its own currency, counting each call once (its reconciled record if there is one).
  const spend = (await c.query(
    `WITH latest AS (SELECT DISTINCT ON (call_id) id FROM call_costs WHERE occurred_at > now() - ($1 || ' days')::interval
                      ORDER BY call_id, CASE status WHEN 'reconciled' THEN 0 ELSE 1 END)
     SELECT l.provider_id, p.name, l.currency, sum(l.amount)::text AS spent FROM call_cost_lines l JOIN latest ON latest.id = l.call_cost_id JOIN providers p ON p.id = l.provider_id
      GROUP BY l.provider_id, p.name, l.currency`, [String(BURN_DAYS)])).rows.map((x) => ({ providerId: x.provider_id as string, provider: x.name as string, currency: String(x.currency).trim(), spent: fromScaled(toScaled(String(x.spent))) }));
  const funded = new Set(balances.map((b) => `${b.provider_id}:${String(b.currency).trim()}`));
  const rows = balances.map((b) => {
    const currency = String(b.currency).trim();
    const s = spend.find((x) => x.providerId === b.provider_id && x.currency === currency);
    const spent = s ? s.spent : fromScaled(0n);
    // Spend in a currency the balance is not kept in cannot be set against it: say so rather than "no spend".
    const elsewhere = spend.filter((x) => x.providerId === b.provider_id && x.currency !== currency).map((x) => ({ currency: x.currency, spent: x.spent }));
    const days = runwayDays(b.balance, spent, BURN_DAYS);
    const balance = fromScaled(toScaled(b.balance));
    return {
      providerId: b.provider_id as string, provider: b.name as string, status: b.status as string, currency, balance, recordedAt: b.recorded_at as Date,
      spent7d: spent, perDay: fromScaled(toScaled(spent) / BigInt(BURN_DAYS)),
      runwayDays: days ?? (toScaled(balance) <= 0n ? '0.0' : null),
      runway: days !== null || toScaled(balance) <= 0n ? 'measured' as const : elsewhere.length > 0 ? 'spend_in_other_currency' as const : 'no_spend' as const,
      spentInOtherCurrencies: elsewhere,
    };
  });
  // A provider that spent money but has no balance recorded in that currency is shown too, with no runway.
  const unfunded = spend.filter((x) => !funded.has(`${x.providerId}:${x.currency}`) && !balances.some((b) => b.provider_id === x.providerId))
    .map((x) => ({ providerId: x.providerId, provider: x.provider, currency: x.currency, spent7d: x.spent }));
  return { providers: rows, spendWithoutBalance: unfunded };
}

const PANELS = { stitching, deliverability, concurrency, journeyQa, learning, modules, funding } as const;
type Panels = { -readonly [K in keyof typeof PANELS]: Awaited<ReturnType<(typeof PANELS)[K]>> | null };

/** Every panel, each worked out on its own: a panel that fails is null with its name in `unavailable`, and the rest still show. */
export async function controlTowerPanels(c: pg.PoolClient, onError: (panel: string, err: unknown) => void = () => {}): Promise<Panels & { generatedAt: string; unavailable: string[] }> {
  const out = {} as Record<string, unknown>; const unavailable: string[] = [];
  // A slow panel is cut off rather than holding up every other one.
  await c.query(`SET LOCAL statement_timeout = '5s'`);
  for (const [name, fn] of Object.entries(PANELS) as [keyof typeof PANELS, (c: pg.PoolClient) => Promise<never>][]) {
    await c.query(`SAVEPOINT panel`);
    try { out[name] = await fn(c); await c.query('RELEASE SAVEPOINT panel'); }
    catch (err) { await c.query('ROLLBACK TO SAVEPOINT panel'); out[name] = null; unavailable.push(name); onError(name, err); }
  }
  return { generatedAt: new Date().toISOString(), ...(out as Panels), unavailable };
}
