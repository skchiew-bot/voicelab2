import type pg from 'pg';
import { z } from 'zod';
import {
  addDays, balanceAfter, bestTimesToCall, channelFor, inQuietHours, isValidZone, localParts, localToInstant, nextAllowed, nextTreatment, plainAmount,
  readBack, retryDelayMinutes, wholeDaysBetween, waitForLimits, type ContactLimits,
} from '../cases/policy.js';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { fromScaled, toScaled } from '../money.js';
import { redactNumbers } from '../telephony/types.js';
import type { Json } from '../workflows/definition.js';
import type { HttpDeps } from '../workflows/integrations.js';
import { audit } from './audit.js';
import { placeOutboundCall, RETRY_AFTER_SECONDS, type CallDeps } from './calls.js';
import { contactHash, contactKeyFrom, contactWindow, getContactPolicy, normalizeE164 } from './dnc.js';
import { recordEvent } from './events.js';
import { integrationsFor } from './runs.js';

const DECIMAL = /^\d{1,16}(\.\d{1,8})?$/;
export const amount = z.string().regex(DECIMAL, 'An amount is a decimal such as 350 or 350.50.');

export interface CaseDeps {
  calls: CallDeps;
  /**
   * Where the number to dial comes from at the moment of the call: the client's own system, looked up by their
   * reference. The number is used for the one dial and never stored. None is connected to a live system yet.
   */
  resolveNumber?: (tenantId: string, contactRef: string, caseRef: string) => Promise<string | null>;
  paymentHttp?: HttpDeps;
}
const asInternal = <T>(d: CaseDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.calls.pool, { kind: 'internal' }, fn);

// ------------------------------------------------------------------------------------------------ settings
export interface CaseSettings {
  paymentIntegration: string | null; paymentPath: string; callbackLatenessMin: number; retryMax: number; retryBackoffMinutes: number[]; rotateAfter: number;
  channels: string[]; treatments: string[]; ageingDays: number; reminderLeadHours: number; brokenGraceDays: number;
}
const DEFAULT_SETTINGS: CaseSettings = {
  paymentIntegration: null, paymentPath: '/cases/{ref}/payments', callbackLatenessMin: 15, retryMax: 3, retryBackoffMinutes: [60, 240, 1440], rotateAfter: 2,
  channels: ['voice', 'whatsapp', 'sms'], treatments: ['friendly', 'firm', 'final'], ageingDays: 30, reminderLeadHours: 24, brokenGraceDays: 1,
};

export async function getSettings(c: pg.PoolClient, tenantId: string): Promise<CaseSettings> {
  const r = (await c.query('SELECT * FROM case_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? {
    paymentIntegration: r.payment_integration, paymentPath: r.payment_path, callbackLatenessMin: r.callback_lateness_min, retryMax: r.retry_max, retryBackoffMinutes: r.retry_backoff_minutes,
    rotateAfter: r.rotate_after, channels: r.channels, treatments: r.treatments, ageingDays: r.ageing_days, reminderLeadHours: r.reminder_lead_hours, brokenGraceDays: r.broken_grace_days,
  } : DEFAULT_SETTINGS;
}

const name = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
export const settingsSchema = z.object({
  paymentIntegration: z.string().min(1).max(60).nullable().optional(), paymentPath: z.string().regex(/^\/[\w\-./{}]{0,200}$/).optional(),
  callbackLatenessMin: z.number().int().min(1).max(1440).optional(), retryMax: z.number().int().min(0).max(20).optional(),
  retryBackoffMinutes: z.array(z.number().int().min(1).max(10080)).min(1).max(10).optional(), rotateAfter: z.number().int().min(1).max(20).optional(),
  channels: z.array(z.enum(['voice', 'whatsapp', 'sms', 'email'])).min(1).max(4).optional(), treatments: z.array(name).min(1).max(8).optional(),
  ageingDays: z.number().int().min(1).max(3650).optional(), reminderLeadHours: z.number().int().min(1).max(720).optional(), brokenGraceDays: z.number().int().min(0).max(60).optional(),
}).strict();

export async function setSettings(c: pg.PoolClient, actorId: string | null, tenantId: string, patch: z.infer<typeof settingsSchema>) {
  const m = { ...(await getSettings(c, tenantId)), ...patch };
  if (m.channels[0] !== 'voice') throw new AppError(400, 'The first channel is always voice: it is how a case is called.');
  if (new Set(m.channels).size !== m.channels.length) throw new AppError(400, 'A channel is listed once.');
  await c.query(
    `INSERT INTO case_settings (tenant_id, payment_integration, payment_path, callback_lateness_min, retry_max, retry_backoff_minutes, rotate_after, channels, treatments, ageing_days, reminder_lead_hours, broken_grace_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (tenant_id) DO UPDATE SET payment_integration = $2, payment_path = $3, callback_lateness_min = $4, retry_max = $5, retry_backoff_minutes = $6, rotate_after = $7,
       channels = $8, treatments = $9, ageing_days = $10, reminder_lead_hours = $11, broken_grace_days = $12, updated_at = now()`,
    [tenantId, m.paymentIntegration, m.paymentPath, m.callbackLatenessMin, m.retryMax, m.retryBackoffMinutes, m.rotateAfter, m.channels, m.treatments, m.ageingDays, m.reminderLeadHours, m.brokenGraceDays]);
  await audit(c, actorId, 'cases.settings', 'tenant', tenantId, { ...patch });
  return getSettings(c, tenantId);
}

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const policySchema = z.object({
  timeZone: z.string().min(1).max(60), quietStart: hhmm.default('21:00'), quietEnd: hhmm.default('08:00'),
  maxPerDay: z.number().int().min(1).max(50).default(3), maxPerWeek: z.number().int().min(1).max(200).default(10), minGapMinutes: z.number().int().min(0).max(10080).default(60),
}).strict();

/** When and how often any contact of this client may be called. Enforced by the dial gate on every outbound call. */
export async function setContactPolicy(c: pg.PoolClient, actorId: string | null, tenantId: string, p: z.infer<typeof policySchema>) {
  if (!isValidZone(p.timeZone)) throw new AppError(400, `"${p.timeZone}" is not a time zone.`);
  if (p.maxPerDay > p.maxPerWeek) throw new AppError(400, 'The weekly limit cannot be lower than the daily one.');
  await c.query(
    `INSERT INTO contact_policy (tenant_id, time_zone, quiet_start, quiet_end, max_per_day, max_per_week, min_gap_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id) DO UPDATE SET time_zone = $2, quiet_start = $3, quiet_end = $4, max_per_day = $5, max_per_week = $6, min_gap_minutes = $7, updated_at = now()`,
    [tenantId, p.timeZone, p.quietStart, p.quietEnd, p.maxPerDay, p.maxPerWeek, p.minGapMinutes]);
  await audit(c, actorId, 'cases.contact_policy', 'tenant', tenantId, { ...p });
  return getContactPolicy(c, tenantId);
}

// ------------------------------------------------------------------------------------------------ cases
async function event(c: pg.PoolClient, caseId: string, kind: string, detail: Record<string, unknown> = {}, actorId: string | null = null, at?: Date) {
  await c.query('INSERT INTO case_events (case_id, kind, detail, actor_id, at) VALUES ($1,$2,$3,$4,coalesce($5, now()))', [caseId, kind, JSON.stringify(detail), actorId, at ?? null]);
}
const lockCase = (c: pg.PoolClient, id: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`case:${id}`]);

export const openCaseSchema = z.object({
  caseRef: z.string().min(1).max(100), contactRef: z.string().max(200).optional(),
  /** Used once to recognise this person when they ring or are dialled; only a keyed hash of it is kept. */
  phone: z.string().min(8).max(20), country: z.string().length(2), currency: z.string().length(3), openingBalance: amount,
  timeZone: z.string().min(1).max(60), language: z.string().min(2).max(10).default('en'),
}).strict();

export async function openCase(c: pg.PoolClient, masterKey: Buffer, actorId: string | null, tenantId: string, e: z.infer<typeof openCaseSchema>) {
  if (!isValidZone(e.timeZone)) throw new AppError(400, `"${e.timeZone}" is not a time zone.`);
  const phone = normalizeE164(e.phone);
  if (!phone) throw new AppError(400, 'The phone number must be in international format. It is used to recognise the person and is not kept.');
  for (const [label, v] of [['case reference', e.caseRef], ['contact reference', e.contactRef ?? '']] as const) {
    if (redactNumbers(v) !== v) throw new AppError(400, `The ${label} looks like a phone number. Use the client's own reference, never the number.`);
  }
  const hash = contactHash(phone, contactKeyFrom(masterKey));
  const row = (await c.query(
    `INSERT INTO cases (tenant_id, case_ref, contact_ref, contact_hash, time_zone, country, currency, language, opening_balance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, case_ref) DO NOTHING RETURNING id`,
    [tenantId, e.caseRef, e.contactRef ?? null, hash, e.timeZone, e.country.toUpperCase(), e.currency.toUpperCase(), e.language, e.openingBalance])).rows[0];
  if (!row) throw new AppError(409, 'That case reference is already open for this client.');
  await event(c, row.id, 'opened', { openingBalance: e.openingBalance, currency: e.currency.toUpperCase() }, actorId);
  await audit(c, actorId, 'case.open', 'case', row.id, { country: e.country });
  return getCase(c, row.id);
}

const caseRow = async (c: pg.PoolClient, id: string) => {
  const r = (await c.query('SELECT * FROM cases WHERE id = $1', [id])).rows[0];
  if (!r) throw new AppError(404, 'Case not found.');
  return r;
};

export async function getCase(c: pg.PoolClient, id: string) {
  const r = await caseRow(c, id);
  const s = await getSettings(c, r.tenant_id);
  const balance = balanceAfter(r.opening_balance, r.paid_total);
  const promises = (await c.query('SELECT id, amount, due_on::text AS due_on, status, created_at, settled_at FROM promises WHERE case_id = $1 ORDER BY created_at', [id])).rows;
  const actions = (await c.query('SELECT id, kind, channel, scheduled_for, status, attempt, call_id, note FROM case_actions WHERE case_id = $1 ORDER BY scheduled_for, created_at', [id])).rows;
  const events = (await c.query('SELECT id, kind, detail, at FROM case_events WHERE case_id = $1 ORDER BY id', [id])).rows;
  const attempts = (await c.query('SELECT local_dow AS dow, local_hour AS hour, outcome FROM case_attempts WHERE case_id = $1', [id])).rows;
  const open = promises.find((p) => p.status === 'open');
  const callback = actions.find((a) => a.kind === 'callback' && a.status === 'pending');
  return {
    id: r.id, tenantId: r.tenant_id, caseRef: r.case_ref, contactRef: r.contact_ref, status: r.status, closeReason: r.close_reason, needsHuman: r.needs_human,
    currency: r.currency.trim(), country: r.country.trim(), timeZone: r.time_zone, language: r.language, openedAt: r.opened_at, closedAt: r.closed_at,
    openingBalance: r.opening_balance, paidTotal: r.paid_total, balance,
    treatment: { level: r.treatment, name: s.treatments[Math.min(r.treatment, s.treatments.length - 1)] },
    promises, actions, events, bestTimes: bestTimesToCall(attempts),
    readBack: readBack({ currency: r.currency.trim(), balance, promise: open ? { amount: open.amount, dueOn: open.due_on } : null, callback: callback ? { at: new Date(callback.scheduled_for).toISOString(), timeZone: r.time_zone } : null }),
  };
}

export const listCases = async (c: pg.PoolClient, tenantId: string, status?: string) =>
  (await c.query(
    `SELECT id, case_ref, contact_ref, status, currency, opening_balance, paid_total, treatment, needs_human, opened_at, close_reason,
            (SELECT count(*)::int FROM case_actions a WHERE a.case_id = cases.id AND a.status = 'pending') AS pending_actions
       FROM cases WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY opened_at DESC LIMIT 200`, [tenantId, status ?? null])).rows;

// ------------------------------------------------------------------------------------------------ callbacks
/**
 * Lock a callback to a time. It is refused inside the contact's quiet hours, and it is placed within a few minutes of
 * exactly then or not at all (see `dispatchDue`).
 */
export async function scheduleCallback(c: pg.PoolClient, actorId: string | null, caseId: string, e: { at: Date; kind?: 'callback' | 'reminder' | 'thanks' | 'handoff'; channel?: string; dedupeKey?: string; note?: string }, now = new Date()) {
  await lockCase(c, caseId);
  const cs = await caseRow(c, caseId);
  if (cs.status !== 'open') throw new AppError(409, `This case is ${cs.status.replace('_', ' ')}, so nothing can be scheduled on it.`);
  if (e.at.getTime() < now.getTime() - 60_000) throw new AppError(400, 'A callback is locked to a time in the future.');
  const pol = await getContactPolicy(c, cs.tenant_id);
  if (pol && inQuietHours(e.at, cs.time_zone, pol.quietStart, pol.quietEnd)) {
    throw new AppError(409, `That time is inside the quiet hours (${pol.quietStart} to ${pol.quietEnd}) in the contact's time zone. The next time they may be called is ${nextAllowed(e.at, cs.time_zone, pol.quietStart, pol.quietEnd).toISOString()}.`);
  }
  const row = (await c.query(
    `INSERT INTO case_actions (case_id, kind, channel, scheduled_for, dedupe_key, note) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (case_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [caseId, e.kind ?? 'callback', e.channel ?? 'voice', e.at, e.dedupeKey ?? null, e.note ?? null])).rows[0];
  if (!row) return { id: null, duplicate: true };
  await event(c, caseId, `${e.kind ?? 'callback'}.scheduled`, { at: e.at.toISOString(), channel: e.channel ?? 'voice' }, actorId);
  await c.query('UPDATE cases SET last_activity_at = now() WHERE id = $1', [caseId]);
  return { id: row.id as string, duplicate: false };
}

/** Put an action at the first allowed moment from `from`, inside no quiet hours. */
async function scheduleNext(c: pg.PoolClient, cs: { id: string; tenant_id: string; time_zone: string }, from: Date, e: { kind: 'retry' | 'callback' | 'thanks' | 'reminder' | 'handoff'; channel: string; dedupeKey: string; attempt?: number; note?: string }) {
  const pol = await getContactPolicy(c, cs.tenant_id);
  const at = pol ? nextAllowed(from, cs.time_zone, pol.quietStart, pol.quietEnd) : from;
  const row = (await c.query(
    `INSERT INTO case_actions (case_id, kind, channel, scheduled_for, dedupe_key, attempt, note) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (case_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [cs.id, e.kind, e.channel, at, e.dedupeKey, e.attempt ?? 1, e.note ?? null])).rows[0];
  if (row) await event(c, cs.id, `${e.kind}.scheduled`, { at: at.toISOString(), channel: e.channel, attempt: e.attempt ?? 1 });
  return at;
}

const cancelActions = (c: pg.PoolClient, caseId: string, why: string) =>
  c.query(`UPDATE case_actions SET status = 'cancelled', note = $2, updated_at = now() WHERE case_id = $1 AND status IN ('pending', 'leased')`, [caseId, why]);

/** A call that was leased and never reported on is not dialled again: whether it went out is unknown. */
export async function expireLeases(c: pg.PoolClient, now: Date) {
  const rows = (await c.query(
    `UPDATE case_actions SET status = 'unknown', note = 'The dial was started but its outcome was never recorded; it is not retried automatically.', updated_at = now()
      WHERE status = 'leased' AND lease_until < $1 RETURNING id, case_id`, [now])).rows;
  for (const r of rows) await event(c, r.case_id, 'action.unknown', { action: r.id });
  return rows.length;
}

/**
 * Place the voice actions that have come due. Each is claimed first (so two dispatchers never take the same one), and
 * placed within the agreed lateness of its time or not at all: a callback an hour late is missed and retried by the
 * rules, never made when the person no longer expects it. Quiet hours and call limits are checked before the dial and
 * again by the gate. A dial that may or may not have gone out is never repeated.
 */
export async function dispatchDue(d: CaseDeps, now = new Date(), limit = 20) {
  const claimed = await asInternal(d, async (c) => {
    await expireLeases(c, now);
    return (await c.query(
      `UPDATE case_actions SET status = 'leased', lease_until = $2, updated_at = now()
        WHERE id IN (SELECT id FROM case_actions WHERE channel = 'voice' AND kind IN ('callback', 'retry', 'reminder', 'thanks') AND status = 'pending' AND scheduled_for <= $1
                      ORDER BY scheduled_for LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING id, case_id, kind, scheduled_for, attempt`, [now, new Date(now.getTime() + 5 * 60_000), limit])).rows;
  });
  const result = { placed: [] as string[], missed: [] as string[], deferred: [] as string[], blocked: [] as string[], failed: [] as string[], unknown: [] as string[], cancelled: [] as string[] };
  for (const a of claimed) {
    try { result[await dispatchOne(d, a, now)].push(a.id as string); }
    catch (err) {
      // One action's trouble must not stop the rest, and it is not tried again by itself.
      await asInternal(d, async (c) => {
        await c.query(`UPDATE case_actions SET status = 'failed', note = $2, updated_at = now() WHERE id = $1 AND status = 'leased'`, [a.id, redactNumbers((err as Error).message).slice(0, 300)]);
        await event(c, a.case_id, 'action.failed', { action: a.id, reason: redactNumbers((err as Error).message).slice(0, 300) });
      });
      result.failed.push(a.id as string);
    }
  }
  return result;
}

async function dispatchOne(d: CaseDeps, a: { id: string; case_id: string; kind: string; scheduled_for: Date; attempt: number }, now: Date): Promise<'placed' | 'missed' | 'deferred' | 'blocked' | 'failed' | 'unknown' | 'cancelled'> {
  const plan = await asInternal(d, async (c) => {
    const cs = await caseRow(c, a.case_id);
    const s = await getSettings(c, cs.tenant_id);
    if (cs.status !== 'open') {
      await c.query(`UPDATE case_actions SET status = 'cancelled', note = $2, updated_at = now() WHERE id = $1`, [a.id, `The case is ${cs.status.replace('_', ' ')}.`]);
      return { done: 'cancelled' as const };
    }
    const lateBy = now.getTime() - new Date(a.scheduled_for).getTime();
    if (lateBy > s.callbackLatenessMin * 60_000) {
      await c.query(`UPDATE case_actions SET status = 'missed', note = 'Not placed within the agreed lateness of its time.', updated_at = now() WHERE id = $1`, [a.id]);
      await event(c, cs.id, `${a.kind}.missed`, { action: a.id, lateMinutes: Math.round(lateBy / 60_000) });
      if (a.kind === 'callback' || a.kind === 'retry') await retryOrStop(c, cs, s, a, now);
      return { done: 'missed' as const };
    }
    const pol = await getContactPolicy(c, cs.tenant_id);
    if (pol) {
      const wait = inQuietHours(now, cs.time_zone, pol.quietStart, pol.quietEnd) ? { until: nextAllowed(now, cs.time_zone, pol.quietStart, pol.quietEnd), reason: 'quiet_hours' }
        : waitForLimits(now, await contactWindow(c, cs.tenant_id, cs.contact_hash, now), pol as ContactLimits);
      if (wait) {
        await c.query(`UPDATE case_actions SET status = 'pending', scheduled_for = $2, lease_until = NULL, note = $3, updated_at = now() WHERE id = $1`, [a.id, wait.until, `Held back: ${wait.reason}.`]);
        await event(c, cs.id, `${a.kind}.deferred`, { action: a.id, reason: wait.reason, until: wait.until.toISOString() });
        return { done: 'deferred' as const };
      }
    }
    return { done: undefined, cs, s };
  });
  if (plan.done) return plan.done;
  const { cs, s } = plan;

  const to = d.resolveNumber ? await d.resolveNumber(cs.tenant_id, cs.contact_ref ?? '', cs.case_ref) : null;
  if (!to) {
    await asInternal(d, async (c) => {
      await c.query(`UPDATE case_actions SET status = 'failed', note = 'No number could be found for this contact, so nothing was dialled.', updated_at = now() WHERE id = $1`, [a.id]);
      await event(c, cs.id, `${a.kind}.failed`, { action: a.id, reason: 'no_number' });
    });
    return 'failed';
  }
  let placed;
  try { placed = await placeOutboundCall(d.calls, null, { tenantId: cs.tenant_id, to, country: cs.country.trim(), timeZone: cs.time_zone, now }); }
  catch (err) {
    const status = err instanceof AppError ? err.status : 0;
    const reason = redactNumbers((err as Error).message).slice(0, 300);
    return asInternal(d, async (c) => {
      // A refusal from the pool (409, 503) is definite. Anything else, including a provider error, may have gone out: do not repeat it.
      const definite = status === 409 || status === 503;
      await c.query(`UPDATE case_actions SET status = $2, note = $3, updated_at = now() WHERE id = $1`, [a.id, definite ? 'failed' : 'unknown', reason]);
      await event(c, cs.id, definite ? `${a.kind}.failed` : 'action.unknown', { action: a.id, reason });
      if (definite && (a.kind === 'callback' || a.kind === 'retry')) await retryOrStop(c, cs, s, a, now);
      return definite ? 'failed' as const : 'unknown' as const;
    });
  }
  return asInternal(d, async (c) => {
    if (!placed.allowed) {
      const policyBlock = placed.reason === 'quiet_hours' || placed.reason === 'contact_limit';
      if (policyBlock) {
        await c.query(`UPDATE case_actions SET status = 'pending', scheduled_for = $2, lease_until = NULL, note = $3, updated_at = now() WHERE id = $1`, [a.id, new Date(now.getTime() + 30 * 60_000), `Held back by the gate: ${placed.reason}.`]);
        await event(c, cs.id, `${a.kind}.deferred`, { action: a.id, reason: placed.reason });
        return 'deferred' as const;
      }
      await c.query(`UPDATE case_actions SET status = 'blocked', call_id = $2, note = $3, updated_at = now() WHERE id = $1`, [a.id, placed.callId, `Blocked: ${placed.reason}.`]);
      await event(c, cs.id, `${a.kind}.blocked`, { action: a.id, reason: placed.reason });
      return 'blocked' as const;
    }
    if ('deferred' in placed && placed.deferred) {
      await c.query(`UPDATE case_actions SET status = 'pending', scheduled_for = $2, lease_until = NULL, note = 'Every provider is full; trying again shortly.', updated_at = now() WHERE id = $1`, [a.id, new Date(now.getTime() + RETRY_AFTER_SECONDS * 1000)]);
      return 'deferred' as const;
    }
    await c.query(`UPDATE case_actions SET status = 'placed', call_id = $2, updated_at = now() WHERE id = $1`, [a.id, placed.callId]);
    await c.query('UPDATE calls SET case_id = $2 WHERE id = $1', [placed.callId, cs.id]);
    await event(c, cs.id, `${a.kind}.placed`, { action: a.id, call: placed.callId });
    await c.query('UPDATE cases SET last_activity_at = now() WHERE id = $1', [cs.id]);
    return 'placed' as const;
  });
}

/** Run a step that must never break the thing it hangs off (a webhook): a failure is rolled back to here and recorded. */
export async function safely<T>(c: pg.PoolClient, label: string, fn: () => Promise<T>): Promise<T | null> {
  await c.query('SAVEPOINT case_step');
  try { const r = await fn(); await c.query('RELEASE SAVEPOINT case_step'); return r; }
  catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT case_step');
    await audit(c, null, 'case.step_failed', 'case', null, { step: label, reason: redactNumbers((err as Error).message).slice(0, 200) });
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ outcomes and retries
interface CaseRow { id: string; tenant_id: string; time_zone: string }

/** After a missed or unanswered try: another by the backoff rules, on the next channel after enough failures, or a decision. */
async function retryOrStop(c: pg.PoolClient, cs: CaseRow, s: CaseSettings, a: { id: string; attempt: number }, now: Date) {
  const failures = (await c.query(
    `SELECT count(*)::int AS n FROM case_attempts WHERE case_id = $1 AND outcome <> 'answered' AND id > coalesce((SELECT max(id) FROM case_attempts WHERE case_id = $1 AND outcome = 'answered'), 0)`, [cs.id])).rows[0].n as number;
  if (a.attempt > s.retryMax) {
    await event(c, cs.id, 'retries_exhausted', { attempts: a.attempt });
    await c.query(`UPDATE cases SET status = 'decision_required', last_activity_at = now() WHERE id = $1 AND status = 'open'`, [cs.id]);
    await event(c, cs.id, 'decision_required', { reason: 'Every retry has been used without reaching the person.' });
    return;
  }
  const delay = retryDelayMinutes(s.retryBackoffMinutes, a.attempt);
  const channel = channelFor(s.channels, Math.max(failures, a.attempt), s.rotateAfter);
  if (channel !== 'voice') await event(c, cs.id, 'channel.rotated', { to: channel, afterFailures: Math.max(failures, a.attempt) });
  await scheduleNext(c, cs, new Date(now.getTime() + delay * 60_000), { kind: 'retry', channel, dedupeKey: `retry:${a.id}`, attempt: a.attempt + 1 });
}

/**
 * A case's call has ended. Record how it went by the contact's local hour (what reachability is learned from), finish
 * the action, and if nobody picked up, schedule the next try. Safe to run twice for one call.
 */
export async function caseCallEnded(c: pg.PoolClient, call: { id: string; started_at: Date; answered_at: Date | null; duration_seconds?: number | null }, endReason: string | undefined, now = new Date()) {
  const a = (await c.query(`SELECT id, case_id, kind, attempt FROM case_actions WHERE call_id = $1 AND status = 'placed' FOR UPDATE`, [call.id])).rows[0];
  if (!a) return null;
  const cs = await caseRow(c, a.case_id);
  const answered = call.answered_at !== null || Number(call.duration_seconds ?? 0) > 0;
  const outcome = answered ? 'answered' : endReason === 'busy' ? 'busy' : endReason === 'failed' ? 'failed' : 'no_answer';
  const p = localParts(call.started_at, cs.time_zone);
  await c.query('INSERT INTO case_attempts (case_id, action_id, call_id, at, local_dow, local_hour, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)', [cs.id, a.id, call.id, call.started_at, p.dow, p.hour, outcome]);
  await c.query(`UPDATE case_actions SET status = $2, updated_at = now() WHERE id = $1`, [a.id, answered ? 'done' : 'missed']);
  await event(c, cs.id, answered ? 'call.answered' : 'call.unanswered', { action: a.id, call: call.id, outcome });
  if (!answered && cs.status === 'open' && (a.kind === 'callback' || a.kind === 'retry')) await retryOrStop(c, cs, await getSettings(c, cs.tenant_id), a, now);
  return { outcome };
}

// ------------------------------------------------------------------------------------------------ promises and payments
export const promiseSchema = z.object({ amount, dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

/** Record a promise to pay, and a reminder before it falls due. One open promise at a time. */
export async function recordPromise(c: pg.PoolClient, actorId: string | null, caseId: string, e: z.infer<typeof promiseSchema>, now = new Date()) {
  await lockCase(c, caseId);
  const cs = await caseRow(c, caseId);
  if (cs.status !== 'open') throw new AppError(409, `This case is ${cs.status.replace('_', ' ')}.`);
  if (Number.isNaN(Date.parse(`${e.dueOn}T00:00:00Z`))) throw new AppError(400, 'That is not a date.');
  if (e.dueOn < localParts(now, cs.time_zone).date) throw new AppError(400, 'A promise is for today or a later day.');
  if (toScaled(e.amount) > toScaled(balanceAfter(cs.opening_balance, cs.paid_total))) throw new AppError(400, 'A promise cannot be for more than the balance.');
  if ((await c.query(`SELECT 1 FROM promises WHERE case_id = $1 AND status = 'open'`, [caseId])).rowCount) throw new AppError(409, 'There is already an open promise on this case. Let it settle first.');
  const p = (await c.query(`INSERT INTO promises (case_id, amount, due_on, paid_base, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [caseId, e.amount, e.dueOn, cs.paid_total, actorId])).rows[0];
  await event(c, caseId, 'promise.recorded', { promise: p.id, amount: e.amount, dueOn: e.dueOn }, actorId);
  const s = await getSettings(c, cs.tenant_id);
  const due = localToInstant(e.dueOn, '09:00', cs.time_zone);
  const remind = new Date(due.getTime() - s.reminderLeadHours * 3_600_000);
  if (remind > now) await scheduleNext(c, cs, remind, { kind: 'reminder', channel: 'voice', dedupeKey: `reminder:${p.id}` });
  else await event(c, caseId, 'reminder.skipped', { promise: p.id, reason: 'The promise falls due too soon for a reminder.' });
  await c.query('UPDATE cases SET last_activity_at = now() WHERE id = $1', [caseId]);
  return { id: p.id as string };
}

const paidOf = (r: Json): string | null => {
  const v = r && typeof r === 'object' && !Array.isArray(r) && Object.hasOwn(r, 'paid') ? (r as Record<string, Json>).paid : null;
  const t = typeof v === 'number' ? null : typeof v === 'string' ? v.trim() : null;   // a number would be a float: only an exact decimal string is taken
  return t !== null && DECIMAL.test(t) ? t : null;
};

/**
 * Ask the client's payment-status integration what a case has paid in total, then settle its open promise: kept (and a
 * thank-you scheduled), part-paid (the balance is recalculated and a person or a plan takes over), or broken (the
 * treatment becomes firmer). Everything is decided from the total, so checking twice never counts a payment twice.
 */
export async function checkPayments(d: CaseDeps, tenantId: string, now = new Date()) {
  const todo = await asInternal(d, async (c) => {
    const s = await getSettings(c, tenantId);
    if (!s.paymentIntegration) return { s, cases: [] as { id: string; case_ref: string }[], integ: null };
    const cases = (await c.query(
      `SELECT DISTINCT c.id, c.case_ref FROM cases c JOIN promises p ON p.case_id = c.id AND p.status = 'open' WHERE c.tenant_id = $1 AND c.status <> 'closed'`, [tenantId])).rows;
    return { s, cases, integ: await integrationsFor(c, tenantId, d.calls.key, 'production', d.paymentHttp) };
  });
  const out = { checked: 0, kept: [] as string[], partial: [] as string[], broken: [] as string[], failed: [] as string[] };
  if (!todo.integ) return out;
  for (const k of todo.cases) {
    let paid: string | null = null;
    try { paid = paidOf(await todo.integ.call(todo.s.paymentIntegration!, { method: 'GET', path: todo.s.paymentPath.replace('{ref}', encodeURIComponent(k.case_ref)) })); }
    catch (err) { await asInternal(d, (c) => event(c, k.id, 'payment_check_failed', { reason: redactNumbers((err as Error).message).slice(0, 200) })); out.failed.push(k.id); continue; }
    if (paid === null) { await asInternal(d, (c) => event(c, k.id, 'payment_check_failed', { reason: 'The reply did not carry a total paid as an exact decimal string.' })); out.failed.push(k.id); continue; }
    out.checked++;
    const r = await asInternal(d, (c) => settleFromTotal(c, k.id, paid!, todo.s, now));
    if (r) out[r].push(k.id);
  }
  return out;
}

export async function settleFromTotal(c: pg.PoolClient, caseId: string, paid: string, s: CaseSettings, now: Date): Promise<'kept' | 'partial' | 'broken' | null> {
  await lockCase(c, caseId);
  const cs = await caseRow(c, caseId);
  if (cs.status === 'closed') return null;
  const before = toScaled(cs.paid_total); const total = toScaled(paid);
  if (total < before) { await event(c, caseId, 'payment_decreased', { reported: paid }); return null; }       // a total that goes down is not applied
  if (total > before) {
    await c.query('UPDATE cases SET paid_total = $2, last_activity_at = now() WHERE id = $1', [caseId, paid]);
    await event(c, caseId, 'payment_received', { total: paid, added: fromScaled(total - before) });
  }
  const balance = balanceAfter(cs.opening_balance, paid);
  const p = (await c.query(`SELECT * FROM promises WHERE case_id = $1 AND status = 'open' FOR UPDATE`, [caseId])).rows[0];
  let result: 'kept' | 'partial' | 'broken' | null = null;
  if (p) {
    const counted = total - toScaled(p.paid_base);
    const due = p.due_on instanceof Date ? p.due_on.toISOString().slice(0, 10) : String(p.due_on);
    const today = localParts(now, cs.time_zone).date;
    if (counted >= toScaled(p.amount)) {
      await c.query(`UPDATE promises SET status = 'kept', settled_at = now() WHERE id = $1`, [p.id]);
      await event(c, caseId, 'promise.kept', { promise: p.id, paid: fromScaled(counted) });
      await scheduleNext(c, cs, now, { kind: 'thanks', channel: 'voice', dedupeKey: `thanks:${p.id}` });
      result = 'kept';
    } else if (today > addDays(due, s.brokenGraceDays)) {
      if (counted > 0n) {
        await c.query(`UPDATE promises SET status = 'partial', settled_at = now() WHERE id = $1`, [p.id]);
        await c.query(`UPDATE cases SET needs_human = true WHERE id = $1`, [caseId]);
        await event(c, caseId, 'promise.partial', { promise: p.id, paid: fromScaled(counted), expected: p.amount, balance });
        await scheduleNext(c, cs, now, { kind: 'handoff', channel: 'voice', dedupeKey: `handoff:${p.id}`, note: 'Part paid: a partial-payment plan or a person takes over.' });
        result = 'partial';
      } else {
        const level = nextTreatment(cs.treatment, s.treatments.length);
        await c.query(`UPDATE promises SET status = 'broken', settled_at = now() WHERE id = $1`, [p.id]);
        await c.query(`UPDATE cases SET treatment = $2 WHERE id = $1`, [caseId, level]);
        await event(c, caseId, 'promise.broken', { promise: p.id, treatment: s.treatments[Math.min(level, s.treatments.length - 1)] });
        await scheduleNext(c, cs, now, { kind: 'callback', channel: 'voice', dedupeKey: `broken:${p.id}`, note: 'A promise was broken: the next call uses the firmer treatment.' });
        result = 'broken';
      }
    }
  }
  if (toScaled(balance) === 0n) {
    await c.query(`UPDATE cases SET status = 'closed', closed_at = now(), close_reason = 'paid_in_full' WHERE id = $1`, [caseId]);
    await cancelActions(c, caseId, 'The case was paid in full.');
    await event(c, caseId, 'closed', { reason: 'paid_in_full' });
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ ageing and decisions
/** An open case that has gone too long without being settled stops being called until a person decides what to do. */
export async function sweepAgeing(c: pg.PoolClient, tenantId: string, now = new Date()) {
  const s = await getSettings(c, tenantId);
  const rows = (await c.query(
    `SELECT c.id, c.opened_at, coalesce((SELECT max(e.at) FROM case_events e WHERE e.case_id = c.id AND e.kind = 'decision'), c.opened_at) AS clock
       FROM cases c WHERE c.tenant_id = $1 AND c.status = 'open'`, [tenantId])).rows;
  const flagged: string[] = [];
  for (const r of rows) {
    if (wholeDaysBetween(new Date(r.clock), now) < s.ageingDays) continue;
    const upd = await c.query(`UPDATE cases SET status = 'decision_required' WHERE id = $1 AND status = 'open'`, [r.id]);
    if (!upd.rowCount) continue;
    await cancelActions(c, r.id, 'The case reached its age limit and waits for a decision.');
    await event(c, r.id, 'decision_required', { reason: `Open for ${wholeDaysBetween(new Date(r.clock), now)} days, over the limit of ${s.ageingDays}.` });
    flagged.push(r.id as string);
  }
  return { flagged };
}

export const decisionSchema = z.object({ decision: z.enum(['continue', 'escalate', 'close']), note: z.string().min(1).max(1000) }).strict();

/** A person decides what happens to a case that cannot go on as it is. Every decision is kept. */
export async function decideCase(c: pg.PoolClient, actorId: string, caseId: string, e: z.infer<typeof decisionSchema>) {
  await lockCase(c, caseId);
  const cs = await caseRow(c, caseId);
  if (cs.status !== 'decision_required') throw new AppError(409, 'This case is not waiting for a decision.');
  const s = await getSettings(c, cs.tenant_id);
  if (e.decision === 'close') {
    await c.query(`UPDATE cases SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1`, [caseId, `decision: ${e.note}`.slice(0, 200)]);
    await cancelActions(c, caseId, 'The case was closed by a decision.');
  } else if (e.decision === 'escalate') {
    await c.query(`UPDATE cases SET status = 'open', needs_human = true, treatment = $2 WHERE id = $1`, [caseId, Math.max(s.treatments.length - 1, 0)]);
  } else {
    await c.query(`UPDATE cases SET status = 'open', last_activity_at = now() WHERE id = $1`, [caseId]);
  }
  await event(c, caseId, 'decision', { decision: e.decision, note: e.note }, actorId);
  await audit(c, actorId, 'case.decide', 'case', caseId, { decision: e.decision });
  return getCase(c, caseId);
}

// ------------------------------------------------------------------------------------------------ inbound and other channels
/** The open case of a person who is ringing, found by the keyed hash of their number. The most recently active wins. */
export async function openCaseFor(c: pg.PoolClient, tenantId: string, hash: string) {
  return (await c.query(
    `SELECT id FROM cases WHERE tenant_id = $1 AND contact_hash = $2 AND status <> 'closed' ORDER BY last_activity_at DESC LIMIT 1`, [tenantId, hash])).rows[0]?.id as string | undefined;
}

/** Link an inbound call to the caller's open case, so the call can carry on where the case left off. */
export async function recogniseInbound(c: pg.PoolClient, call: { id: string; tenant_id: string; project_id: string | null }, hash: string) {
  await c.query('UPDATE calls SET contact_hash = $2 WHERE id = $1 AND contact_hash IS NULL', [call.id, hash]);
  const caseId = await openCaseFor(c, call.tenant_id, hash);
  if (!caseId) return null;
  await c.query('UPDATE calls SET case_id = $2 WHERE id = $1', [call.id, caseId]);
  await event(c, caseId, 'inbound.recognised', { call: call.id });
  await recordEvent(c, { tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId: call.id, type: 'case.recognised', payload: { caseId } });
  await c.query('UPDATE cases SET last_activity_at = now() WHERE id = $1', [caseId]);
  return caseId;
}

/**
 * What a workflow needs to carry on a case: the arrangement and where things stand. No number, no personal detail. The
 * call's own variables take precedence over these.
 */
export async function caseVariables(c: pg.PoolClient, caseId: string): Promise<Record<string, Json>> {
  const v = await getCase(c, caseId);
  const open = v.promises.find((p: { status: string }) => p.status === 'open');
  return {
    case_ref: v.caseRef, case_balance: plainAmount(v.balance), case_currency: v.currency, case_treatment: v.treatment.name ?? 'friendly',
    case_arrangement: v.readBack, ...(open ? { promise_amount: plainAmount(open.amount), promise_due: open.due_on } : {}),
  };
}

/** Actions waiting on a channel the platform cannot send on itself (a message): for the client's own sender to pick up. */
export const listOutbox = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(
    `SELECT a.id, a.case_id, c.case_ref, c.contact_ref, a.kind, a.channel, a.scheduled_for FROM case_actions a JOIN cases c ON c.id = a.case_id
      WHERE c.tenant_id = $1 AND a.status = 'pending' AND (a.channel <> 'voice' OR a.kind = 'handoff') ORDER BY a.scheduled_for LIMIT 200`, [tenantId])).rows;

export async function completeAction(c: pg.PoolClient, actorId: string | null, actionId: string, note?: string) {
  const a = (await c.query(`UPDATE case_actions SET status = 'done', note = coalesce($2, note), updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING case_id`, [actionId, note ?? null])).rows[0];
  if (!a) throw new AppError(409, 'That action is not waiting.');
  await event(c, a.case_id, 'action.completed', { action: actionId, note: note ?? null }, actorId);
  return { done: true };
}

export async function cancelCase(c: pg.PoolClient, actorId: string | null, caseId: string, reason: string) {
  await lockCase(c, caseId);
  const cs = await caseRow(c, caseId);
  if (cs.status === 'closed') throw new AppError(409, 'That case is already closed.');
  await c.query(`UPDATE cases SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1`, [caseId, reason.slice(0, 200)]);
  await cancelActions(c, caseId, 'The case was closed.');
  await event(c, caseId, 'closed', { reason }, actorId);
  return getCase(c, caseId);
}

export async function caseSummary(c: pg.PoolClient, tenantId?: string) {
  const r = (await c.query(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'decision_required')::int AS decision_required, count(*) FILTER (WHERE needs_human AND status <> 'closed')::int AS needs_human
       FROM cases WHERE ($1::uuid IS NULL OR tenant_id = $1)`, [tenantId ?? null])).rows[0];
  const missed = (await c.query(`SELECT count(*)::int AS n FROM case_actions a JOIN cases c ON c.id = a.case_id WHERE a.status IN ('missed', 'unknown') AND a.updated_at > now() - interval '7 days' AND ($1::uuid IS NULL OR c.tenant_id = $1)`, [tenantId ?? null])).rows[0].n as number;
  return { open: r.open as number, decisionRequired: r.decision_required as number, needsHuman: r.needs_human as number, missedOrUnknown: missed };
}
