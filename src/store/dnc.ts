import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../errors.js';
import { inQuietHours, waitForLimits, type Window } from '../cases/policy.js';
import { audit } from './audit.js';
import { recordEvent } from './events.js';

/** Key for hashing numbers, derived from the master key so a leaked table cannot be reversed by a lookup table. */
export const dncKeyFrom = (masterKey: Buffer): Buffer =>
  createHmac('sha256', masterKey).update('voicelab-dnc-v1').digest();

export function normalizeE164(raw: string): string | null {
  const s = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

const hashNumber = (e164: string, key: Buffer) => createHmac('sha256', key).update(e164).digest('hex');

export async function declareRegistry(
  c: pg.PoolClient, actorId: string,
  e: { country: string; requirement: 'registry' | 'none_required'; source: string },
) {
  const { rows } = await c.query(
    `INSERT INTO dnc_registries (country, requirement, source, declared_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (country) DO UPDATE SET requirement = $2, source = $3, declared_by = $4
     RETURNING country, requirement, source, created_at`,
    [e.country, e.requirement, e.source, actorId],
  );
  await audit(c, actorId, 'dnc.declare', 'country', e.country, { requirement: e.requirement, source: e.source });
  return rows[0];
}

export const listRegistries = async (c: pg.PoolClient) =>
  (await c.query(
    `SELECT r.country, r.requirement, r.source, r.created_at,
            (SELECT count(*)::int FROM dnc_entries d WHERE d.country = r.country AND d.tenant_id IS NULL) AS national_entries
       FROM dnc_registries r ORDER BY r.country`)).rows;

export async function addNumbers(
  c: pg.PoolClient, key: Buffer, actorId: string,
  e: { country: string; tenantId?: string; numbers: string[]; source?: string },
) {
  const reg = (await c.query('SELECT requirement FROM dnc_registries WHERE country = $1', [e.country])).rows[0];
  if (!reg) throw new AppError(400, `Declare ${e.country}'s do-not-call requirement first.`);
  if (!e.tenantId && reg.requirement !== 'registry') {
    throw new AppError(400, `${e.country} is declared as having no registry, so national numbers cannot be loaded for it.`);
  }
  let added = 0; const invalid: string[] = [];
  for (const raw of e.numbers) {
    const n = normalizeE164(raw);
    if (!n) { invalid.push(raw); continue; }
    const res = await c.query(
      `INSERT INTO dnc_entries (country, tenant_id, number_hash, source) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [e.country, e.tenantId ?? null, hashNumber(n, key), e.source ?? null],
    );
    added += res.rowCount ?? 0;
  }
  await audit(c, actorId, 'dnc.add', 'country', e.country, { added, invalid: invalid.length, tenantId: e.tenantId ?? null });
  return { added, duplicates: e.numbers.length - invalid.length - added, invalid };
}

export async function removeNumber(
  c: pg.PoolClient, key: Buffer, actorId: string, e: { country: string; tenantId?: string; number: string },
) {
  const n = normalizeE164(e.number);
  if (!n) throw new AppError(400, 'Number must be in international format, e.g. +60123456789.');
  const res = await c.query(
    `DELETE FROM dnc_entries WHERE country = $1 AND number_hash = $2
       AND tenant_id IS NOT DISTINCT FROM $3::uuid`,
    [e.country, hashNumber(n, key), e.tenantId ?? null],
  );
  await audit(c, actorId, 'dnc.remove', 'country', e.country, { removed: res.rowCount ?? 0 });
  return { removed: res.rowCount ?? 0 };
}

export type DialDecision =
  | { allowed: true }
  | { allowed: false; reason: 'invalid_number' | 'no_registry_declared' | 'on_national_registry' | 'on_client_list' | 'quiet_hours' | 'contact_limit' };

/**
 * The hard pre-dial gate. It fails closed: an unparseable number, or a country
 * nobody has declared a do-not-call position for, is blocked.
 */
export async function preDialCheck(
  c: pg.PoolClient, key: Buffer, e: { tenantId: string; country: string; to: string; contactHash?: string; timeZone?: string; now?: Date },
): Promise<DialDecision> {
  const n = normalizeE164(e.to);
  if (!n) return { allowed: false, reason: 'invalid_number' };
  const reg = (await c.query('SELECT 1 FROM dnc_registries WHERE country = $1', [e.country])).rows[0];
  if (!reg) return { allowed: false, reason: 'no_registry_declared' };
  const hit = (await c.query(
    `SELECT tenant_id IS NULL AS national FROM dnc_entries
      WHERE country = $1 AND number_hash = $2 AND (tenant_id IS NULL OR tenant_id = $3)
      ORDER BY (tenant_id IS NULL) DESC LIMIT 1`,
    [e.country, hashNumber(n, key), e.tenantId],
  )).rows[0];
  if (hit) return { allowed: false, reason: hit.national ? 'on_national_registry' : 'on_client_list' };
  // The client's own rules about when and how often a person may be called, for every dial, not only those of a case.
  if (e.contactHash) {
    const pol = await getContactPolicy(c, e.tenantId);
    if (pol) {
      const now = e.now ?? new Date();
      // The contact's own zone, if they have an open case; else the client's. One dial to a contact is judged at a time, so two at once cannot both pass.
      const own = e.timeZone ?? (await c.query(`SELECT time_zone FROM cases WHERE tenant_id = $1 AND contact_hash = $2 AND status <> 'closed' ORDER BY last_activity_at DESC LIMIT 1`, [e.tenantId, e.contactHash])).rows[0]?.time_zone as string | undefined;
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contact:${e.tenantId}:${e.contactHash}`]);
      if (inQuietHours(now, own ?? pol.timeZone, pol.quietStart, pol.quietEnd)) return { allowed: false, reason: 'quiet_hours' };
      if (waitForLimits(now, await contactWindow(c, e.tenantId, e.contactHash, now), pol)) return { allowed: false, reason: 'contact_limit' };
    }
  }
  return { allowed: true };
}

export interface ContactPolicy { timeZone: string; quietStart: string; quietEnd: string; maxPerDay: number; maxPerWeek: number; minGapMinutes: number }
export async function getContactPolicy(c: pg.PoolClient, tenantId: string): Promise<ContactPolicy | null> {
  const r = (await c.query('SELECT * FROM contact_policy WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? { timeZone: r.time_zone, quietStart: r.quiet_start, quietEnd: r.quiet_end, maxPerDay: r.max_per_day, maxPerWeek: r.max_per_week, minGapMinutes: r.min_gap_minutes } : null;
}

/** How many times this contact has been called lately, whoever placed the call. A call that never went out does not count. */
export async function contactWindow(c: pg.PoolClient, tenantId: string, hash: string, now: Date): Promise<Window> {
  const r = (await c.query(
    `SELECT count(*) FILTER (WHERE started_at > $3::timestamptz - interval '24 hours')::int AS day, count(*)::int AS week, max(started_at) AS last
       FROM calls WHERE tenant_id = $1 AND contact_hash = $2 AND direction = 'outbound' AND status NOT IN ('blocked', 'failed')
        AND started_at > $3::timestamptz - interval '7 days'`, [tenantId, hash, now])).rows[0];
  return { dayCount: r.day, weekCount: r.week, lastAt: r.last ?? null };
}

/**
 * Every outbound dial goes through this. The decision is written to the call
 * event log without the number, so a block is auditable but leaks nothing.
 */
export async function gateOutbound(
  c: pg.PoolClient, key: Buffer,
  e: { tenantId: string; projectId?: string; callId: string; country: string; to: string; contactHash?: string; timeZone?: string; now?: Date },
): Promise<DialDecision> {
  const decision = await preDialCheck(c, key, e);
  await recordEvent(c, {
    tenantId: e.tenantId, projectId: e.projectId, callId: e.callId,
    type: decision.allowed ? 'dial.allowed' : 'dial.blocked',
    payload: decision.allowed ? { country: e.country } : { country: e.country, reason: decision.reason },
  });
  return decision;
}

/**
 * Who a call was dialled to, as a keyed hash that cannot be turned back into the number. It lets the DID pool
 * remember which numbers failed for which contact without keeping the contact's number.
 */
export const contactKeyFrom = (masterKey: Buffer): Buffer =>
  createHmac('sha256', masterKey).update('voicelab-contact-v1').digest();
export const contactHash = (e164: string, key: Buffer): string => hashNumber(e164, key);
