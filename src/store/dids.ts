import type pg from 'pg';
import { AppError } from '../errors.js';
import { fromScaled, mulDiv, SCALE, toScaled } from '../money.js';
import { audit } from './audit.js';
import { perUsd } from './costs.js';
import { recordEvent } from './events.js';

export const DID_FAILURE_REASONS = ['spam_flagged', 'carrier_blocked', 'rejected_on_sight', 'caller_id_invalid'] as const;
export type DidFailureReason = (typeof DID_FAILURE_REASONS)[number];

/** USD per minute a provider charges for the outbound telephony leg now, or null if no rate is captured. */
export async function outboundPerMinuteUsd(c: pg.PoolClient, providerId: string, at: Date): Promise<bigint | null> {
  const version = (await c.query(
    `SELECT id FROM charging_versions WHERE provider_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [providerId, at])).rows[0];
  if (!version) return null;
  const comps = (await c.query(
    `SELECT unit, rate, currency FROM charging_components
      WHERE charging_version_id = $1 AND component = 'telephony_leg' AND billing_line <> 'relay' AND direction IN ('any', 'outbound') AND unit IN ('per_minute', 'per_second')`, [version.id])).rows;
  if (comps.length === 0) return null;
  let total = 0n;
  for (const k of comps) {
    const perMinute = k.unit === 'per_second' ? mulDiv(toScaled(k.rate), 60n, 1n) : toScaled(k.rate);
    // A currency with no exchange rate makes the price unknown, not the whole dial impossible.
    try { total += mulDiv(perMinute, SCALE, await perUsd(c, k.currency, at)); } catch { return null; }
  }
  return total;
}

export type DidChoice =
  | { ok: true; phoneNumberId: string; e164: string; providerId: string; priceKnown: boolean; perMinuteUsd: string | null; candidates: number; locked: number }
  | { ok: false; reason: 'no_numbers' | 'all_locked_for_contact' | 'providers_unhealthy' | 'at_capacity'; candidates: number; locked: number };

/**
 * The DID check, run before every dial. A DID that has ever failed for this contact is out for good. Of the rest,
 * the cheapest provider's numbers are used, and within it the one used least recently, so a pool wears evenly.
 * It writes to the call-event log without any number.
 */
export async function chooseDid(
  c: pg.PoolClient,
  e: {
    tenantId: string; projectId?: string; callId: string; country: string; contactHash: string; providerId?: string; at?: Date;
    /** Providers judged failed or out of funding: never chosen. */
    unhealthy?: ReadonlySet<string>;
    /** Providers already at their concurrency ceiling: not chosen, so the call goes to one with room (or waits). */
    full?: ReadonlySet<string>;
  },
): Promise<DidChoice> {
  const at = e.at ?? new Date();
  // Two dials choosing at once must not both take the same number.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`did:${e.tenantId}:${e.country}`]);
  const pool = (await c.query(
    `SELECT n.id, n.e164, n.provider_id, n.last_used_at, n.use_count,
            coalesce((SELECT k.preferred FROM provider_controls k WHERE k.provider_id = n.provider_id), false) AS preferred,
            -- locked by the number the contact sees: the same number at another provider is the same caller ID
            EXISTS (SELECT 1 FROM did_failures f JOIN phone_numbers fn ON fn.id = f.phone_number_id
                     WHERE f.tenant_id = n.tenant_id AND fn.e164 = n.e164 AND f.contact_hash = $4) AS locked
       FROM phone_numbers n JOIN providers p ON p.id = n.provider_id
      WHERE n.tenant_id = $1 AND n.country = $2 AND n.status = 'active' AND p.kind = 'telephony' AND p.status = 'active'
        AND ($3::uuid IS NULL OR n.provider_id = $3)`,
    [e.tenantId, e.country, e.providerId ?? null, e.contactHash])).rows as
    { id: string; e164: string; provider_id: string; last_used_at: Date | null; use_count: number; preferred: boolean; locked: boolean }[];
  const notLocked = pool.filter((n) => !n.locked);
  const healthy = notLocked.filter((n) => !e.unhealthy?.has(n.provider_id));
  const eligible = healthy.filter((n) => !e.full?.has(n.provider_id));
  const locked = pool.length - notLocked.length;
  const finish = async (choice: DidChoice) => {
    await recordEvent(c, {
      tenantId: e.tenantId, projectId: e.projectId, callId: e.callId, type: choice.ok ? 'did.selected' : 'did.none_available',
      payload: choice.ok
        ? { phoneNumberId: choice.phoneNumberId, providerId: choice.providerId, candidates: choice.candidates, locked: choice.locked, priceKnown: choice.priceKnown }
        : { reason: choice.reason, candidates: choice.candidates, locked: choice.locked },
    });
    return choice;
  };
  if (eligible.length === 0) {
    const reason = pool.length === 0 ? 'no_numbers' : notLocked.length === 0 ? 'all_locked_for_contact' : healthy.length === 0 ? 'providers_unhealthy' : 'at_capacity';
    return finish({ ok: false, reason, candidates: pool.length, locked });
  }

  const price = new Map<string, bigint | null>();
  for (const pid of new Set(eligible.map((n) => n.provider_id))) price.set(pid, await outboundPerMinuteUsd(c, pid, at));
  // A provider an operator preferred comes first; then providers with a known price, cheapest first; a provider with no
  // captured rate is used only if no priced one is eligible.
  const rank = (pid: string) => price.get(pid) ?? null;
  // A preference never puts an unpriced provider ahead of a priced one: a call that cannot be priced is refused, not guessed.
  const preferred = new Set(eligible.filter((n) => n.preferred && price.get(n.provider_id) != null).map((n) => n.provider_id));
  const cheapest = [...new Set(eligible.map((n) => n.provider_id))].sort((a, b) => {
    if (preferred.has(a) !== preferred.has(b)) return preferred.has(a) ? -1 : 1;
    const x = rank(a); const y = rank(b);
    if (x === null && y === null) return a < b ? -1 : 1;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : 1;
  })[0]!;
  const picked = eligible.filter((n) => n.provider_id === cheapest)
    .sort((a, b) => (a.last_used_at?.getTime() ?? -Infinity) - (b.last_used_at?.getTime() ?? -Infinity) || a.use_count - b.use_count || (a.id < b.id ? -1 : 1))[0]!;
  await c.query('UPDATE phone_numbers SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1', [picked.id]);
  const p = rank(cheapest);
  return finish({ ok: true, phoneNumberId: picked.id, e164: picked.e164, providerId: cheapest, priceKnown: p !== null, perMinuteUsd: p === null ? null : fromScaled(p), candidates: pool.length, locked });
}

/** Is this specific DID usable for this contact? Used when an operator names the caller ID instead of letting the pool choose. */
export async function didLockedFor(c: pg.PoolClient, tenantId: string, phoneNumberId: string, contactHash: string): Promise<boolean> {
  return (await c.query(
    `SELECT 1 FROM did_failures f JOIN phone_numbers fn ON fn.id = f.phone_number_id JOIN phone_numbers n ON n.e164 = fn.e164
      WHERE f.tenant_id = $1 AND n.id = $2 AND f.contact_hash = $3 LIMIT 1`, [tenantId, phoneNumberId, contactHash])).rowCount === 1;
}

/**
 * Record that the DID a call was dialled from failed for its contact: from now on that DID is never used for that
 * contact. The contact is known only by the hash stored on the call, so no number is needed here or kept.
 */
export async function recordDidFailure(c: pg.PoolClient, actorId: string | null, callId: string, reason: DidFailureReason) {
  const call = (await c.query('SELECT id, tenant_id, from_number_id, contact_hash, direction, status, end_reason FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call) throw new AppError(404, 'Call not found.');
  if (call.direction !== 'outbound' || !call.from_number_id || !call.contact_hash) throw new AppError(409, 'That call was not dialled from a pooled number, so there is no DID to lock.');
  // A call that never went out (blocked, or refused by this very check) says nothing about how the DID fared with a carrier.
  if (call.status === 'blocked' || ['did_locked', 'all_locked_for_contact', 'no_numbers'].includes(call.end_reason ?? '')) {
    throw new AppError(409, 'That call was never dialled, so it cannot show a DID failing.');
  }
  const exists = (await c.query('SELECT 1 FROM did_failures WHERE phone_number_id = $1 AND contact_hash = $2 AND call_id = $3', [call.from_number_id, call.contact_hash, callId])).rowCount;
  if (!exists) {
    await c.query(
      `INSERT INTO did_failures (tenant_id, phone_number_id, contact_hash, reason, call_id, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [call.tenant_id, call.from_number_id, call.contact_hash, reason, callId, actorId]);
    await recordEvent(c, { tenantId: call.tenant_id, callId, type: 'did.locked', payload: { phoneNumberId: call.from_number_id, reason } });
    await audit(c, actorId, 'did.lock', 'call', callId, { phoneNumberId: call.from_number_id, reason });
  }
  return { phoneNumberId: call.from_number_id as string, reason, alreadyLocked: Boolean(exists) };
}

/** The pool as the console shows it: use, failures, and how many contacts each number is locked from. */
export const listPool = async (c: pg.PoolClient, tenantId?: string) =>
  (await c.query(
    `SELECT n.id, n.e164, n.provider_id, n.tenant_id, n.country, n.label, n.status, n.use_count, n.last_used_at, n.inbound_workflow_id,
            (SELECT count(*)::int FROM did_failures f WHERE f.phone_number_id = n.id) AS failures,
            (SELECT count(DISTINCT f.contact_hash)::int FROM did_failures f WHERE f.phone_number_id = n.id) AS contacts_locked
       FROM phone_numbers n WHERE ($1::uuid IS NULL OR n.tenant_id = $1) ORDER BY n.country, n.provider_id, n.e164`, [tenantId ?? null])).rows;
