import type pg from 'pg';
import { AppError } from '../errors.js';
import { DEFAULT_POLICY, HEALTHY, nextHealth, type Health, type Policy, type Sample, type State } from '../resilience/failover.js';
import type { FallbackPlan } from '../resilience/fallback.js';
import { audit } from './audit.js';

// ----------------------------------------------------------------------------------------------- policy
const rowToPolicy = (r: Record<string, number>): Policy => ({
  errorThreshold: r.error_threshold!, errorWindowMs: r.error_window_s! * 1000, latencyThresholdMs: r.latency_threshold_ms!,
  latencyWindowMs: r.latency_window_s! * 1000, latencyMinSamples: r.latency_min_samples!, deadAirMs: r.dead_air_ms!,
  recoveryOkSamples: r.recovery_ok_samples!, recoveryDwellMs: r.recovery_dwell_s! * 1000,
});

export async function getPolicy(c: pg.PoolClient): Promise<Policy> {
  const r = (await c.query('SELECT * FROM resilience_policy WHERE id = 1')).rows[0];
  return r ? rowToPolicy(r) : DEFAULT_POLICY;
}

const COLUMNS: Record<keyof Policy, string> = {
  errorThreshold: 'error_threshold', errorWindowMs: 'error_window_s', latencyThresholdMs: 'latency_threshold_ms', latencyWindowMs: 'latency_window_s',
  latencyMinSamples: 'latency_min_samples', deadAirMs: 'dead_air_ms', recoveryOkSamples: 'recovery_ok_samples', recoveryDwellMs: 'recovery_dwell_s',
};

/** Change thresholds. Windows and the dwell are given in milliseconds here and kept in seconds. */
export async function setPolicy(c: pg.PoolClient, actorId: string | null, patch: Partial<Policy>): Promise<Policy> {
  const sets: string[] = []; const args: number[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof Policy, number][]) {
    if (v === undefined) continue;
    const seconds = k.endsWith('WindowMs') || k === 'recoveryDwellMs';
    args.push(seconds ? Math.ceil(v / 1000) : v); sets.push(`${COLUMNS[k]} = $${args.length}`);
  }
  if (sets.length) {
    await c.query(`UPDATE resilience_policy SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, args);
    await audit(c, actorId, 'resilience.policy', 'resilience_policy', '1', patch as Record<string, unknown>);
  }
  return getPolicy(c);
}

// -------------------------------------------------------------------------------------------- funding
/** False when a provider's recorded balance has run out in any currency; undefined when no funding is recorded for it. */
export async function fundedState(c: pg.PoolClient, providerId: string): Promise<boolean | undefined> {
  // Compared as exact decimals in the database, not as floating point.
  const r = (await c.query(
    `SELECT count(*)::int AS currencies, coalesce(bool_and(balance > 0), true) AS funded
       FROM (SELECT currency, sum(amount) AS balance FROM provider_funding_entries WHERE provider_id = $1 GROUP BY currency) b`, [providerId])).rows[0];
  return r.currencies === 0 ? undefined : r.funded;
}

// ------------------------------------------------------------------------------------------ failover log
export interface FailoverInput {
  scope: 'provider_health' | 'voice' | 'telephony' | 'fallback'; tenantId?: string; callId?: string; runId?: string;
  from?: string | null; to?: string | null; trigger: string; detail?: Record<string, unknown>;
}
export async function logFailover(c: pg.PoolClient, e: FailoverInput) {
  await c.query(
    `INSERT INTO failover_events (scope, tenant_id, call_id, run_id, from_provider, to_provider, trigger, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.scope, e.tenantId ?? null, e.callId ?? null, e.runId ?? null, e.from ?? null, e.to ?? null, e.trigger, e.detail ?? {}]);
}

export const listFailovers = async (c: pg.PoolClient, limit = 100) =>
  (await c.query(
    `SELECT f.id, f.scope, f.tenant_id, f.call_id, f.from_provider, f.to_provider, f.trigger, f.detail, f.at,
            pf.name AS from_name, pt.name AS to_name
       FROM failover_events f LEFT JOIN providers pf ON pf.id = f.from_provider LEFT JOIN providers pt ON pt.id = f.to_provider
      ORDER BY f.id DESC LIMIT $1`, [limit])).rows;

// ------------------------------------------------------------------------------------------------ health
async function loadHealth(c: pg.PoolClient, providerId: string): Promise<Health> {
  const r = (await c.query('SELECT state, reason, ok_streak, since FROM provider_health WHERE provider_id = $1', [providerId])).rows[0];
  return r ? { state: r.state, reason: r.reason ?? undefined, okStreak: r.ok_streak, since: new Date(r.since).getTime() } : { ...HEALTHY };
}

/** Health of providers, by id. A provider with no record is healthy. */
export async function healthMap(c: pg.PoolClient, providerIds?: string[]): Promise<Map<string, State>> {
  const rows = (await c.query('SELECT provider_id, state FROM provider_health WHERE ($1::uuid[] IS NULL OR provider_id = ANY($1))', [providerIds ?? null])).rows;
  return new Map(rows.map((r) => [r.provider_id as string, r.state as State]));
}

async function applyHealth(c: pg.PoolClient, providerId: string, now: Date, funded: boolean | undefined, tenantId?: string, callId?: string) {
  const policy = await getPolicy(c);
  const health = await loadHealth(c, providerId);
  const horizon = Math.max(policy.errorWindowMs, policy.latencyWindowMs, policy.recoveryDwellMs) + 60_000;
  const recent = (await c.query(
    `SELECT kind, latency_ms, probe, at FROM provider_samples WHERE provider_id = $1 AND at > $2 ORDER BY at, id`,
    [providerId, new Date(now.getTime() - horizon)])).rows
    .map((r): Sample => ({ at: new Date(r.at).getTime(), kind: r.kind, latencyMs: r.latency_ms ?? undefined, probe: r.probe }));
  const out = nextHealth(health, recent, now.getTime(), policy, funded);
  if (out.transition || out.health.okStreak !== health.okStreak) {
    await c.query(
      `INSERT INTO provider_health (provider_id, state, reason, ok_streak, since, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (provider_id) DO UPDATE SET state = $2, reason = $3, ok_streak = $4, since = $5, updated_at = now()`,
      [providerId, out.health.state, out.health.reason ?? null, out.health.okStreak, new Date(out.health.since || now.getTime())]);
  }
  if (out.transition) {
    await logFailover(c, { scope: 'provider_health', tenantId, callId, from: providerId, trigger: out.transition.trigger, detail: { from: out.transition.from, to: out.transition.to, reason: out.health.reason ?? null } });
  }
  return { state: out.health.state, transition: out.transition };
}

/** One attempt by a provider, good or bad. Health is re-assessed from the recent window; a switch is logged. */
export async function recordSample(
  c: pg.PoolClient,
  e: { providerId: string; kind: Sample['kind']; latencyMs?: number; callId?: string; tenantId?: string; probe?: boolean; at?: Date },
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`health:${e.providerId}`]);
  const at = e.at ?? new Date();
  await c.query('INSERT INTO provider_samples (provider_id, kind, latency_ms, call_id, probe, at) VALUES ($1,$2,$3,$4,$5,$6)',
    [e.providerId, e.kind, e.latencyMs ?? null, e.callId ?? null, e.probe ?? false, at]);
  // Once a provider is out of funding it stays so until a top-up says otherwise: a stray sample (a probe, a late reply) must not lift it.
  const funded = (await loadHealth(c, e.providerId)).state === 'unfunded' ? undefined : await fundedState(c, e.providerId);
  return applyHealth(c, e.providerId, at, funded, e.tenantId, e.callId);
}

/**
 * Re-check a provider's funding without a new attempt: after a top-up, a ledger change, or on a schedule.
 * An empty balance fails the provider over immediately; a top-up puts it on probation.
 */
export async function syncFunding(c: pg.PoolClient, providerId: string, e: { at?: Date; topUp?: boolean } = {}) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`health:${providerId}`]);
  const funded = await fundedState(c, providerId);
  // A provider that said it has no credit is released only by a top-up, not by any other ledger entry.
  const stays = funded === true && !e.topUp && (await loadHealth(c, providerId)).state === 'unfunded';
  return applyHealth(c, providerId, e.at ?? new Date(), stays ? undefined : funded);
}

/** A provider said it has no credit left. That is believed at once and not retried, whatever our own ledger says. */
export async function markUnfunded(c: pg.PoolClient, providerId: string, e: { tenantId?: string; callId?: string; at?: Date } = {}) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`health:${providerId}`]);
  return applyHealth(c, providerId, e.at ?? new Date(), false, e.tenantId, e.callId);
}

export async function providerHealthViews(c: pg.PoolClient) {
  return (await c.query(
    `SELECT p.id AS provider_id, p.name, p.kind, p.status, coalesce(h.state, 'healthy') AS state, h.reason, h.since, coalesce(h.ok_streak, 0) AS ok_streak
       FROM providers p LEFT JOIN provider_health h ON h.provider_id = p.id ORDER BY p.name`)).rows;
}

// ------------------------------------------------------------------------------------------------ routes
export async function setRoutes(c: pg.PoolClient, actorId: string | null, tenantId: string, role: 'voice', providerIds: string[]) {
  if (new Set(providerIds).size !== providerIds.length) throw new AppError(400, 'A provider can be listed once.');
  if (providerIds.length) {
    const found = (await c.query(`SELECT id FROM providers WHERE id = ANY($1) AND kind = 'voice' AND status = 'active'`, [providerIds])).rowCount;
    if (found !== providerIds.length) throw new AppError(400, 'Every provider in a voice route must be an active voice provider.');
  }
  await c.query('DELETE FROM provider_routes WHERE tenant_id = $1 AND role = $2', [tenantId, role]);
  for (const [i, id] of providerIds.entries()) await c.query('INSERT INTO provider_routes (tenant_id, role, provider_id, priority) VALUES ($1,$2,$3,$4)', [tenantId, role, id, i]);
  await audit(c, actorId, 'routes.set', 'tenant', tenantId, { role, providers: providerIds.length });
  return getRoutes(c, tenantId, role);
}

export const getRoutes = async (c: pg.PoolClient, tenantId: string, role: 'voice') =>
  (await c.query(
    `SELECT r.provider_id AS "providerId", r.priority, p.name FROM provider_routes r JOIN providers p ON p.id = r.provider_id
      WHERE r.tenant_id = $1 AND r.role = $2 ORDER BY r.priority`, [tenantId, role])).rows as { providerId: string; priority: number; name: string }[];

// ------------------------------------------------------------------------------------- fallback plan
export async function setFallbackPlan(c: pg.PoolClient, actorId: string | null, tenantId: string, p: FallbackPlan) {
  await c.query(
    `INSERT INTO fallback_plans (tenant_id, holding_message, offer_callback, human_transfer, voicemail) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET holding_message = $2, offer_callback = $3, human_transfer = $4, voicemail = $5, updated_at = now()`,
    [tenantId, p.holdingMessage, p.offerCallback, p.humanTransfer, p.voicemail]);
  await audit(c, actorId, 'fallback.set', 'tenant', tenantId, { offerCallback: p.offerCallback, humanTransfer: p.humanTransfer, voicemail: p.voicemail });
  return getFallbackPlan(c, tenantId);
}

export async function getFallbackPlan(c: pg.PoolClient, tenantId: string): Promise<FallbackPlan | null> {
  const r = (await c.query('SELECT * FROM fallback_plans WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? { holdingMessage: r.holding_message, offerCallback: r.offer_callback, humanTransfer: r.human_transfer, voicemail: r.voicemail } : null;
}

export async function addCallbackRequest(c: pg.PoolClient, e: { tenantId: string; callId: string; contactRef?: string; reason: string }) {
  await c.query('INSERT INTO callback_requests (tenant_id, call_id, contact_ref, reason) VALUES ($1,$2,$3,$4)', [e.tenantId, e.callId, e.contactRef ?? null, e.reason]);
}
