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
  // What was said on real and test calls (not rehearsals) in the last 7 days: characters synthesised and characters played from recordings.
  const rows = (await c.query(
    `SELECT w.id AS workflow_id, w.name AS workflow, t.name AS tenant,
            coalesce(sum((s.payload->>'synthChars')::bigint), 0)::bigint AS synth, coalesce(sum((s.payload->>'recordedChars')::bigint), 0)::bigint AS recorded
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id JOIN workflows w ON w.id = r.workflow_id JOIN tenants t ON t.id = r.tenant_id
      WHERE s.type = 'say' AND r.kind IN ('live', 'test') AND s.created_at > now() - interval '7 days'
      GROUP BY w.id, w.name, t.name ORDER BY (coalesce(sum((s.payload->>'synthChars')::bigint), 0) + coalesce(sum((s.payload->>'recordedChars')::bigint), 0)) DESC LIMIT 20`)).rows;
  const workflows = rows.map((r) => {
    const synth = Number(r.synth); const recorded = Number(r.recorded);
    return { workflowId: r.workflow_id as string, workflow: r.workflow as string, tenant: r.tenant as string, synthChars: synth, recordedChars: recorded, recordedPercent: percent(recorded, synth + recorded) };
  });
  const synth = workflows.reduce((n, w) => n + w.synthChars, 0); const recorded = workflows.reduce((n, w) => n + w.recordedChars, 0);
  return { synthChars: synth, recordedChars: recorded, recordedPercent: percent(recorded, synth + recorded), workflows };
}

async function deliverability(c: pg.PoolClient) {
  const pool = (await c.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'retired')::int AS retired FROM phone_numbers`)).rows[0];
  const failures = (await c.query(
    `SELECT reason, count(*)::int AS n, count(DISTINCT phone_number_id)::int AS numbers FROM did_failures WHERE created_at > now() - interval '7 days' GROUP BY reason ORDER BY n DESC`)).rows;
  // Dials that really went out: a dial the gate or the pool refused never reached anyone, so it is not counted (lesson L-005).
  const dials = (await c.query(
    `SELECT count(*)::int AS dialled, count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered
       FROM calls WHERE direction = 'outbound' AND started_at > now() - interval '7 days' AND status NOT IN ('blocked')
        AND coalesce(end_reason, '') NOT IN ('did_locked', 'all_locked_for_contact', 'no_numbers', 'providers_unhealthy')`)).rows[0];
  const outcomes = (await c.query(
    `SELECT outcome, count(*)::int AS n FROM outbound_outcomes WHERE created_at > now() - interval '7 days' GROUP BY outcome ORDER BY outcome`)).rows;
  const contacted = outcomes.find((o) => o.outcome === 'contacted')?.n ?? 0;
  return {
    pool: { active: pool.active as number, retired: pool.retired as number }, failures,
    dialled: dials.dialled as number, answered: dials.answered as number, answerPercent: percent(dials.answered, dials.dialled),
    outcomes, contactPercent: percent(contacted, dials.dialled),
  };
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
    `SELECT count(*)::int AS scored, round(avg(score), 2)::text AS average,
            count(*) FILTER (WHERE score < 50)::int AS b0, count(*) FILTER (WHERE score >= 50 AND score < 70)::int AS b50,
            count(*) FILTER (WHERE score >= 70 AND score < 90)::int AS b70, count(*) FILTER (WHERE score >= 90)::int AS b90
       FROM qa_scores WHERE created_at > now() - interval '7 days'`)).rows[0];
  const escalations = (await c.query(
    `SELECT trigger, count(*)::int AS n FROM tickets WHERE kind = 'escalation' AND created_at > now() - interval '7 days' GROUP BY trigger ORDER BY n DESC`)).rows;
  const faults = (await c.query(`SELECT count(*)::int AS n FROM calls c WHERE c.fault AND NOT EXISTS (SELECT 1 FROM fault_acks a WHERE a.call_id = c.id)`)).rows[0].n as number;
  // How callers sounded, day by day: the average sentiment of the turns that were read (sensitive answers never are).
  const sentiment = (await c.query(
    `SELECT to_char(date_trunc('day', s.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS turns,
            round(avg((s.payload->'analysis'->>'sentiment')::numeric), 2)::text AS average,
            count(*) FILTER (WHERE (s.payload->'analysis'->>'severe')::boolean)::int AS severe
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE s.type = 'heard' AND r.kind IN ('live', 'test') AND s.payload ? 'analysis' AND s.created_at > now() - interval '7 days'
      GROUP BY 1 ORDER BY 1`)).rows;
  return {
    qa: { scored: qa.scored as number, average: qa.scored > 0 ? (qa.average as string) : null, distribution: [
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
  const cascades = (await c.query(`SELECT count(*)::int AS moved FROM appointment_events WHERE kind = 'delayed' AND at > now() - interval '7 days'`)).rows[0].moved as number;
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
     SELECT l.provider_id, l.currency, sum(l.amount)::text AS spent FROM call_cost_lines l JOIN latest ON latest.id = l.call_cost_id GROUP BY l.provider_id, l.currency`, [String(BURN_DAYS)])).rows;
  return balances.map((b) => {
    const currency = String(b.currency).trim();
    const s = spend.find((x) => x.provider_id === b.provider_id && String(x.currency).trim() === currency);
    const spent = s ? fromScaled(toScaled(String(s.spent))) : '0';
    return {
      providerId: b.provider_id as string, provider: b.name as string, status: b.status as string, currency, balance: fromScaled(toScaled(b.balance)), recordedAt: b.recorded_at as Date,
      spent7d: spent, perDay: fromScaled(toScaled(spent) / BigInt(BURN_DAYS)), runwayDays: runwayDays(b.balance, spent, BURN_DAYS),
    };
  });
}

const PANELS = { stitching, deliverability, concurrency, journeyQa, learning, modules, funding } as const;
type Panels = { -readonly [K in keyof typeof PANELS]: Awaited<ReturnType<(typeof PANELS)[K]>> | null };

/** Every panel, each worked out on its own: a panel that fails is null with its name in `unavailable`, and the rest still show. */
export async function controlTowerPanels(c: pg.PoolClient): Promise<Panels & { generatedAt: string; unavailable: string[] }> {
  const out = {} as Record<string, unknown>; const unavailable: string[] = [];
  for (const [name, fn] of Object.entries(PANELS) as [keyof typeof PANELS, (c: pg.PoolClient) => Promise<never>][]) {
    await c.query(`SAVEPOINT panel`);
    try { out[name] = await fn(c); await c.query('RELEASE SAVEPOINT panel'); }
    catch { await c.query('ROLLBACK TO SAVEPOINT panel'); out[name] = null; unavailable.push(name); }
  }
  return { generatedAt: new Date().toISOString(), ...(out as Panels), unavailable };
}
