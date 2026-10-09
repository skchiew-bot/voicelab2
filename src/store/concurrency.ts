import type pg from 'pg';
import { AppError } from '../errors.js';
import { toScaled, fromScaled, mulDiv } from '../money.js';
import { audit } from './audit.js';
import { recordEvent } from './events.js';

const ACTIVE = `('dialing', 'ringing', 'in_progress')`;

export interface Load { providerId: string; active: number; ceiling: number | null }

/**
 * How busy each provider is against the concurrency limit in its rates. Above the limit a provider charges a premium
 * (burst pricing), so a call that would pass it is sent elsewhere, held back, or knowingly paid for at a premium.
 */
export async function providerLoad(c: pg.PoolClient, providerIds: string[], at = new Date()): Promise<Map<string, Load>> {
  const out = new Map<string, Load>();
  for (const providerId of providerIds) {
    const active = (await c.query(`SELECT count(*)::int AS n FROM calls WHERE provider_id = $1 AND status IN ${ACTIVE}`, [providerId])).rows[0].n as number;
    const v = (await c.query(
      `SELECT concurrency_limit FROM charging_versions WHERE provider_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [providerId, at])).rows[0];
    out.set(providerId, { providerId, active, ceiling: v?.concurrency_limit ?? null });
  }
  return out;
}

export const isFull = (l: Load) => l.ceiling !== null && l.active >= l.ceiling;

// ------------------------------------------------------------------------------------------ entitlements
export interface Entitlement { inbound_channels: number; extra_channels: number; extra_channel_credits: string; overburst_multiplier: string | null }

export async function getEntitlement(c: pg.PoolClient, tenantId: string): Promise<Entitlement | null> {
  return (await c.query('SELECT inbound_channels, extra_channels, extra_channel_credits, overburst_multiplier FROM tenant_entitlements WHERE tenant_id = $1', [tenantId])).rows[0] ?? null;
}

export async function setEntitlement(
  c: pg.PoolClient, actorId: string | null, tenantId: string,
  e: { inboundChannels: number; extraChannels?: number; extraChannelCredits?: string; overburstMultiplier?: string | null },
) {
  await c.query(
    `INSERT INTO tenant_entitlements (tenant_id, inbound_channels, extra_channels, extra_channel_credits, overburst_multiplier) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET inbound_channels = $2, extra_channels = $3, extra_channel_credits = $4, overburst_multiplier = $5, updated_at = now()`,
    [tenantId, e.inboundChannels, e.extraChannels ?? 0, e.extraChannelCredits ?? '0', e.overburstMultiplier ?? null]);
  await audit(c, actorId, 'entitlement.set', 'tenant', tenantId, { inboundChannels: e.inboundChannels, extraChannels: e.extraChannels ?? 0, overburst: e.overburstMultiplier != null });
  return getEntitlement(c, tenantId);
}

export type Admission = { admit: 'admit' } | { admit: 'premium'; creditMultiplier: string } | { admit: 'queue' };

/**
 * Whether an inbound call may start now. A client with no entitlement set is not limited. Within its channels a call
 * is admitted. Beyond them it is admitted at the client's agreed premium if it has one, and otherwise it waits.
 */
export async function inboundAdmission(c: pg.PoolClient, tenantId: string): Promise<Admission & { active: number; channels: number | null }> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inbound:${tenantId}`]);
  const ent = await getEntitlement(c, tenantId);
  if (!ent) return { admit: 'admit', active: 0, channels: null };
  const channels = ent.inbound_channels + ent.extra_channels;
  const active = (await c.query(`SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1 AND direction = 'inbound' AND status IN ('ringing', 'in_progress')`, [tenantId])).rows[0].n as number;
  if (active < channels) return { admit: 'admit', active, channels };
  if (ent.overburst_multiplier) return { admit: 'premium', creditMultiplier: ent.overburst_multiplier, active, channels };
  return { admit: 'queue', active, channels };
}

/** A channel has freed: the call that has waited longest moves up. Returns its id, or null if nobody is waiting or no room. */
export async function promoteQueued(c: pg.PoolClient, tenantId: string): Promise<string | null> {
  const adm = await inboundAdmission(c, tenantId);
  if (adm.admit === 'queue') return null;
  const next = (await c.query(
    `SELECT id, project_id FROM calls WHERE tenant_id = $1 AND direction = 'inbound' AND status = 'queued' ORDER BY queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenantId])).rows[0];
  if (!next) return null;
  await c.query(`UPDATE calls SET status = 'in_progress', answered_at = coalesce(answered_at, now()) WHERE id = $1`, [next.id]);
  await recordEvent(c, { tenantId, projectId: next.project_id ?? undefined, callId: next.id, type: 'call.dequeued', payload: {} });
  return next.id as string;
}

/**
 * Queued callers who have waited too long are not left hanging: the call ends, and a callback request is recorded so
 * the client can follow up. No priced time is billed for a call that never got a channel.
 */
export async function expireQueued(c: pg.PoolClient, actorId: string | null, maxWaitSeconds: number) {
  const rows = (await c.query(
    `SELECT id, tenant_id, project_id FROM calls WHERE status = 'queued' AND queued_at < now() - make_interval(secs => $1) ORDER BY queued_at LIMIT 200 FOR UPDATE SKIP LOCKED`, [maxWaitSeconds])).rows;
  for (const r of rows) {
    await c.query(`UPDATE calls SET status = 'unanswered', ended_at = now(), end_reason = 'queue_timeout', cost_status = 'not_applicable' WHERE id = $1`, [r.id]);
    await c.query(`INSERT INTO callback_requests (tenant_id, call_id, reason) VALUES ($1,$2,'waited too long for a channel')`, [r.tenant_id, r.id]);
    await recordEvent(c, { tenantId: r.tenant_id, projectId: r.project_id ?? undefined, callId: r.id, type: 'call.queue_timeout', payload: { maxWaitSeconds } });
  }
  if (rows.length) await audit(c, actorId, 'queue.expired', 'calls', null, { count: rows.length });
  return { expired: rows.length };
}

/**
 * Charge a client for its extra channels for one month, once. The charge is a usage entry in the credit ledger with a
 * reference for the month; the month's row makes a repeat a no-op rather than a second charge.
 */
export async function chargeExtraChannels(c: pg.PoolClient, actorId: string | null, tenantId: string, month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError(400, 'Month must look like 2026-07.');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`channels:${tenantId}:${month}`]);
  const done = (await c.query('SELECT extra_channels, credits FROM channel_charges WHERE tenant_id = $1 AND month = $2', [tenantId, month])).rows[0];
  if (done) return { charged: false as const, extraChannels: done.extra_channels as number, credits: done.credits as string };
  const ent = await getEntitlement(c, tenantId);
  if (!ent || ent.extra_channels === 0 || toScaled(ent.extra_channel_credits) === 0n) return { charged: false as const, extraChannels: ent?.extra_channels ?? 0, credits: '0.0000' };
  const total = mulDiv(toScaled(ent.extra_channel_credits), BigInt(ent.extra_channels), 1n);
  const credits = fromScaled(mulDiv(total, 1n, 10_000n) * 10_000n).slice(0, -4);   // kept to 4 decimal places
  await c.query(`INSERT INTO credit_entries (tenant_id, kind, credits, ref) VALUES ($1,'usage',$2,$3)`, [tenantId, `-${credits}`, `channels:${month}`]);
  await c.query('INSERT INTO channel_charges (tenant_id, month, extra_channels, credits) VALUES ($1,$2,$3,$4)', [tenantId, month, ent.extra_channels, credits]);
  await audit(c, actorId, 'channels.charge', 'tenant', tenantId, { month, extraChannels: ent.extra_channels, credits });
  return { charged: true as const, extraChannels: ent.extra_channels, credits };
}

