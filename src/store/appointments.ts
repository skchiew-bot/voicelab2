import type pg from 'pg';
import { z } from 'zod';
import { cascade, feeFor, fits, freeStarts, messageFor, occupied, whenText, type Booked, type DayHours, type Interval, type MessageKind } from '../appointments/schedule.js';
import { addDays, isValidZone, localParts, localToInstant } from '../cases/policy.js';
import { AppError } from '../errors.js';
import { toScaled } from '../money.js';
import { redactNumbers } from '../telephony/types.js';
import { audit } from './audit.js';
import { cleanNote } from './cases.js';

const DECIMAL = /^\d{1,16}(\.\d{1,8})?$/;
const CHANNELS = ['whatsapp', 'sms', 'email'] as const;
type Channel = (typeof CHANNELS)[number];
const ACTIVE = ['booked', 'needs_reschedule'];

/** A reference, an address or a note: a customer's phone number never goes into one. */
const noNumber = (text: string | undefined | null, label: string): string | undefined => cleanNote(text, label);
const refOk = (ref: string, label: string): string => {
  if (redactNumbers(ref) !== ref) throw new AppError(400, `The ${label} looks like a phone number. Use the client's own reference.`);
  return ref;
};

async function event(c: pg.PoolClient, appointmentId: string, kind: string, detail: Record<string, unknown> = {}, actorId: string | null = null) {
  await c.query('INSERT INTO appointment_events (appointment_id, kind, detail, actor_id) VALUES ($1,$2,$3,$4)', [appointmentId, kind, JSON.stringify(detail), actorId]);
}
const lockDiary = (c: pg.PoolClient, id: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`diary:${id}`]);
/** Take several diaries' locks in one fixed order, so two requests that need the same diaries cannot each hold one and wait for the other. */
async function lockDiaries(c: pg.PoolClient, ids: string[]) { for (const id of [...new Set(ids)].sort()) await lockDiary(c, id); }

// ------------------------------------------------------------------------------------------------ locations and diaries
export const locationSchema = z.object({ name: z.string().min(1).max(100), address: z.string().min(1).max(300) }).strict();
export async function createLocation(c: pg.PoolClient, actorId: string | null, tenantId: string, e: z.infer<typeof locationSchema>) {
  noNumber(e.address, 'address');
  const r = (await c.query('INSERT INTO locations (tenant_id, name, address) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id, name, address', [tenantId, e.name, e.address])).rows[0];
  if (!r) throw new AppError(409, 'A location with that name already exists.');
  await audit(c, actorId, 'location.create', 'location', r.id, {});
  return r;
}
export const listLocations = async (c: pg.PoolClient, tenantId: string) => (await c.query('SELECT id, name, address FROM locations WHERE tenant_id = $1 ORDER BY name', [tenantId])).rows;

export const diarySchema = z.object({
  name: z.string().min(1).max(100), kind: z.enum(['individual', 'group']), officerRef: z.string().min(1).max(200).optional(), officerChannel: z.enum(CHANNELS).default('whatsapp'),
  timeZone: z.string().min(1).max(60), members: z.array(z.string().uuid()).max(100).optional(),
}).strict();

export async function createDiary(c: pg.PoolClient, actorId: string | null, tenantId: string, e: z.infer<typeof diarySchema>) {
  if (!isValidZone(e.timeZone)) throw new AppError(400, `"${e.timeZone}" is not a time zone.`);
  if (e.kind === 'individual') {
    if (!e.officerRef) throw new AppError(400, 'An individual diary is for one officer: give their reference.');
    if (e.members?.length) throw new AppError(400, 'Only a group diary has members.');
    refOk(e.officerRef, 'officer reference');
  } else {
    if (e.officerRef) throw new AppError(400, 'A group diary has members, not one officer.');
    if (!e.members?.length) throw new AppError(400, 'A group diary needs at least one member.');
    const found = (await c.query(`SELECT id FROM diaries WHERE tenant_id = $1 AND kind = 'individual' AND active AND id = ANY($2::uuid[])`, [tenantId, e.members])).rows;
    if (found.length !== new Set(e.members).size) throw new AppError(400, 'Every member must be an active individual diary of this client.');
  }
  const r = (await c.query(
    `INSERT INTO diaries (tenant_id, name, kind, officer_ref, officer_channel, time_zone) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
    [tenantId, e.name, e.kind, e.officerRef ?? null, e.officerChannel, e.timeZone])).rows[0];
  if (!r) throw new AppError(409, 'A diary with that name already exists.');
  for (const m of new Set(e.members ?? [])) await c.query('INSERT INTO diary_members (group_id, member_id) VALUES ($1,$2)', [r.id, m]);
  await audit(c, actorId, 'diary.create', 'diary', r.id, { kind: e.kind });
  return getDiary(c, r.id);
}

export async function getDiary(c: pg.PoolClient, id: string) {
  const d = (await c.query('SELECT * FROM diaries WHERE id = $1', [id])).rows[0];
  if (!d) throw new AppError(404, 'Diary not found.');
  const hours = (await c.query('SELECT dow, starts, ends FROM diary_hours WHERE diary_id = $1 ORDER BY dow', [id])).rows;
  const members = (await c.query('SELECT m.id, m.name FROM diary_members g JOIN diaries m ON m.id = g.member_id WHERE g.group_id = $1 ORDER BY m.name', [id])).rows;
  const blocks = (await c.query('SELECT id, starts_at, ends_at, reason FROM diary_blocks WHERE diary_id = $1 AND ends_at > now() ORDER BY starts_at', [id])).rows;
  return { id: d.id, tenantId: d.tenant_id, name: d.name, kind: d.kind, officerRef: d.officer_ref, officerChannel: d.officer_channel, timeZone: d.time_zone, active: d.active, hours, members, blocks };
}
export const listDiaries = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(`SELECT id, name, kind, officer_ref, time_zone, active, (SELECT count(*)::int FROM diary_members m WHERE m.group_id = diaries.id) AS members FROM diaries WHERE tenant_id = $1 ORDER BY name`, [tenantId])).rows;

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const hoursSchema = z.object({ hours: z.array(z.object({ dow: z.number().int().min(0).max(6), starts: hhmm, ends: hhmm })).max(7) }).strict();
/** The days and times an individual diary is open. Replaces the week. */
export async function setHours(c: pg.PoolClient, actorId: string | null, diaryId: string, e: z.infer<typeof hoursSchema>) {
  const d = await getDiary(c, diaryId);
  if (d.kind !== 'individual') throw new AppError(400, 'Hours belong to an individual diary; a group offers its members\' hours.');
  if (new Set(e.hours.map((h) => h.dow)).size !== e.hours.length) throw new AppError(400, 'A day is listed once.');
  if (e.hours.some((h) => h.starts >= h.ends)) throw new AppError(400, 'A day opens before it closes.');
  await lockDiary(c, diaryId);
  const week = new Map(e.hours.map((h) => [h.dow, h]));
  const future = (await c.query(`SELECT starts_at, ends_at FROM appointments WHERE diary_id = $1 AND status = ANY($3) AND ends_at > $2`, [diaryId, new Date(), ACTIVE])).rows;
  const stranded = future.filter((r) => {
    const p = localParts(r.starts_at, d.timeZone); const h = week.get(p.dow);
    return !h || r.starts_at < localToInstant(p.date, h.starts, d.timeZone) || r.ends_at > localToInstant(p.date, h.ends, d.timeZone);
  });
  if (stranded.length) throw new AppError(409, `${stranded.length} booked appointment${stranded.length === 1 ? ' falls' : 's fall'} outside those hours. Move or cancel ${stranded.length === 1 ? 'it' : 'them'} first.`);
  await c.query('DELETE FROM diary_hours WHERE diary_id = $1', [diaryId]);
  for (const h of e.hours) await c.query('INSERT INTO diary_hours (diary_id, dow, starts, ends) VALUES ($1,$2,$3,$4)', [diaryId, h.dow, h.starts, h.ends]);
  await audit(c, actorId, 'diary.hours', 'diary', diaryId, { days: e.hours.length });
  return getDiary(c, diaryId);
}

export const blockSchema = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().min(1).max(200) }).strict();
/** Time off. Refused over a booked appointment: move or cancel that first, so nobody is left holding a time that no longer exists. */
export async function addBlock(c: pg.PoolClient, actorId: string | null, diaryId: string, e: z.infer<typeof blockSchema>) {
  const d = await getDiary(c, diaryId);
  if (d.kind !== 'individual') throw new AppError(400, 'Time off is set on an individual diary.');
  const from = new Date(e.startsAt); const to = new Date(e.endsAt);
  if (from >= to) throw new AppError(400, 'Time off starts before it ends.');
  noNumber(e.reason, 'reason');
  await lockDiary(c, diaryId);
  const clash = (await c.query(`SELECT id FROM appointments WHERE diary_id = $1 AND status = ANY($4) AND starts_at < $3 AND ends_at > $2`, [diaryId, from, to, ACTIVE])).rows;
  if (clash.length) throw new AppError(409, `${clash.length} appointment${clash.length === 1 ? ' is' : 's are'} booked in that time. Move or cancel ${clash.length === 1 ? 'it' : 'them'} first.`);
  const r = (await c.query('INSERT INTO diary_blocks (diary_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING id', [diaryId, from, to, e.reason])).rows[0];
  await audit(c, actorId, 'diary.block', 'diary', diaryId, {});
  return { id: r.id as string };
}

// ------------------------------------------------------------------------------------------------ policy
export interface Policy { freeUntilHours: number; lateFee: string; noShowFee: string; currency: string; reminderHours: number; customerChannel: Channel }
const DEFAULT_POLICY: Policy = { freeUntilHours: 24, lateFee: '0.00000000', noShowFee: '0.00000000', currency: 'MYR', reminderHours: 24, customerChannel: 'whatsapp' };
export async function getPolicy(c: pg.PoolClient, tenantId: string): Promise<Policy> {
  const r = (await c.query('SELECT * FROM cancellation_policy WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? { freeUntilHours: r.free_until_hours, lateFee: r.late_fee, noShowFee: r.no_show_fee, currency: r.currency.trim(), reminderHours: r.reminder_hours, customerChannel: r.customer_channel } : DEFAULT_POLICY;
}
export const policySchema = z.object({
  freeUntilHours: z.number().int().min(0).max(720).optional(), lateFee: z.string().regex(DECIMAL).optional(), noShowFee: z.string().regex(DECIMAL).optional(),
  currency: z.string().length(3).optional(), reminderHours: z.number().int().min(1).max(336).optional(), customerChannel: z.enum(CHANNELS).optional(),
}).strict();
export async function setPolicy(c: pg.PoolClient, actorId: string | null, tenantId: string, patch: z.infer<typeof policySchema>) {
  const m = { ...(await getPolicy(c, tenantId)), ...patch, currency: (patch.currency ?? (await getPolicy(c, tenantId)).currency).toUpperCase() };
  await c.query(
    `INSERT INTO cancellation_policy (tenant_id, free_until_hours, late_fee, no_show_fee, currency, reminder_hours, customer_channel) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id) DO UPDATE SET free_until_hours = $2, late_fee = $3, no_show_fee = $4, currency = $5, reminder_hours = $6, customer_channel = $7, updated_at = now()`,
    [tenantId, m.freeUntilHours, m.lateFee, m.noShowFee, m.currency, m.reminderHours, m.customerChannel]);
  await audit(c, actorId, 'appointments.policy', 'tenant', tenantId, { ...patch });
  return getPolicy(c, tenantId);
}

// ------------------------------------------------------------------------------------------------ free times
interface DiaryRow { id: string; tenant_id: string; kind: string; time_zone: string; officer_ref: string | null; officer_channel: Channel; name: string; active: boolean }
const diaryRow = async (c: pg.PoolClient, id: string): Promise<DiaryRow> => {
  const d = (await c.query('SELECT * FROM diaries WHERE id = $1', [id])).rows[0];
  if (!d) throw new AppError(404, 'Diary not found.');
  return d;
};
const membersOf = async (c: pg.PoolClient, d: DiaryRow): Promise<DiaryRow[]> =>
  d.kind === 'individual' ? [d] : (await c.query(`SELECT m.* FROM diary_members g JOIN diaries m ON m.id = g.member_id WHERE g.group_id = $1 AND m.active ORDER BY m.name`, [d.id])).rows;

/** The day's hours for a diary, in its zone, or null if it is closed that day. */
async function hoursOn(c: pg.PoolClient, d: DiaryRow, date: string): Promise<DayHours | null> {
  const dow = localParts(localToInstant(date, '12:00', d.time_zone), d.time_zone).dow;
  const h = (await c.query('SELECT starts, ends FROM diary_hours WHERE diary_id = $1 AND dow = $2', [d.id, dow])).rows[0];
  return h ? { date, starts: h.starts, ends: h.ends, timeZone: d.time_zone } : null;
}
/** Everything that keeps a diary busy around a day: its appointments (with their journeys) and its time off. */
async function busyAround(c: pg.PoolClient, diaryId: string, around: Date, exclude?: string): Promise<Interval[]> {
  const from = new Date(around.getTime() - 48 * 3_600_000); const to = new Date(around.getTime() + 48 * 3_600_000);
  const appts = (await c.query(`SELECT starts_at, ends_at, travel_minutes FROM appointments WHERE diary_id = $1 AND status = ANY($4) AND ends_at > $2 AND starts_at < $3 AND ($5::uuid IS NULL OR id <> $5)`, [diaryId, from, to, ACTIVE, exclude ?? null])).rows;
  const blocks = (await c.query('SELECT starts_at, ends_at FROM diary_blocks WHERE diary_id = $1 AND ends_at > $2 AND starts_at < $3', [diaryId, from, to])).rows;
  return [...appts.map((a) => occupied({ startsAt: a.starts_at, endsAt: a.ends_at, travelMinutes: a.travel_minutes })), ...blocks.map((b) => ({ from: b.starts_at as Date, to: b.ends_at as Date }))];
}

/** Free start times on a date for a diary, or for a group (each time with the members who can take it). */
export async function availableSlots(c: pg.PoolClient, diaryId: string, e: { date: string; durationMinutes: number; travelMinutes?: number }, now = new Date()) {
  const d = await diaryRow(c, diaryId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new AppError(400, 'The date is YYYY-MM-DD.');
  if (e.durationMinutes < 5 || e.durationMinutes > 480) throw new AppError(400, 'An appointment lasts between 5 minutes and 8 hours.');
  const slots = new Map<string, string[]>();
  for (const m of await membersOf(c, d)) {
    const day = await hoursOn(c, m, e.date);
    if (!day) continue;
    const starts = freeStarts({ day, durationMinutes: e.durationMinutes, travelMinutes: e.travelMinutes ?? 0, busy: await busyAround(c, m.id, localToInstant(e.date, '12:00', m.time_zone)), now });
    for (const s of starts) slots.set(s.toISOString(), [...(slots.get(s.toISOString()) ?? []), m.id]);
  }
  return [...slots].sort(([a], [b]) => a.localeCompare(b)).map(([startsAt, diaries]) => ({ startsAt, diaries }));
}

// ------------------------------------------------------------------------------------------------ notifications
interface ApptRow {
  id: string; tenant_id: string; diary_id: string; contact_ref: string; customer_channel: Channel; kind: string; location_id: string | null; visit_address: string | null;
  starts_at: Date; ends_at: Date; travel_minutes: number; status: string; original_starts_at: Date; fee: string; case_id: string | null;
}
const placeText = async (c: pg.PoolClient, a: ApptRow) => a.kind === 'at_location'
  ? `at ${(await c.query('SELECT name FROM locations WHERE id = $1', [a.location_id])).rows[0]?.name ?? 'the branch'}` : 'at your address';
const officerPlace = async (c: pg.PoolClient, a: ApptRow) => a.kind === 'at_location'
  ? `at ${(await c.query('SELECT name FROM locations WHERE id = $1', [a.location_id])).rows[0]?.name ?? 'the branch'}` : `visit to ${a.visit_address}`;

async function notify(c: pg.PoolClient, a: ApptRow, d: DiaryRow, to: 'customer' | 'officer', kind: MessageKind, o: { was?: Date; minutes?: number; fee?: string; currency?: string; dedupe?: string } = {}): Promise<boolean> {
  const when = whenText(a.starts_at, d.time_zone);
  const body = messageFor(kind, { when, was: o.was ? whenText(o.was, d.time_zone) : undefined, where: to === 'officer' ? await officerPlace(c, a) : await placeText(c, a), minutes: o.minutes, fee: o.fee, currency: o.currency, for: to });
  const r = await c.query(
    `INSERT INTO notifications (tenant_id, appointment_id, recipient_kind, recipient_ref, channel, kind, body, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (appointment_id, recipient_kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [a.tenant_id, a.id, to, to === 'officer' ? d.officer_ref : a.contact_ref, to === 'officer' ? d.officer_channel : a.customer_channel, kind, body, o.dedupe ?? null]);
  return (r.rowCount ?? 0) > 0;
}
const apptRow = async (c: pg.PoolClient, id: string, lock = false): Promise<ApptRow> => {
  const a = (await c.query(`SELECT * FROM appointments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!a) throw new AppError(404, 'Appointment not found.');
  return a;
};

// ------------------------------------------------------------------------------------------------ booking
export const bookSchema = z.object({
  diaryId: z.string().uuid(), contactRef: z.string().min(1).max(200), customerChannel: z.enum(CHANNELS).optional(),
  kind: z.enum(['at_location', 'field_visit']), locationId: z.string().uuid().optional(), visitAddress: z.string().min(1).max(300).optional(),
  travelMinutes: z.number().int().min(0).max(600).default(0), startsAt: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(5).max(480),
  caseId: z.string().uuid().optional(), note: z.string().max(300).optional(),
}).strict();

/** The individual diary that can take a booking at `start`: the diary itself, or the least busy member of a group that is free then. */
async function chooseDiary(c: pg.PoolClient, d: DiaryRow, start: Date, durationMinutes: number, travelMinutes: number, now: Date, exclude?: string): Promise<DiaryRow | null> {
  const members = await membersOf(c, d);
  await lockDiaries(c, members.map((m) => m.id));
  const candidates: { m: DiaryRow; load: number }[] = [];
  for (const m of members) {
    const date = localParts(start, m.time_zone).date;
    const day = await hoursOn(c, m, date);
    if (!day || !m.active) continue;
    if (!fits({ day, start, durationMinutes, travelMinutes, busy: await busyAround(c, m.id, start, exclude), now })) continue;
    // How busy the officer already is that day, by their own calendar day.
    const from = localToInstant(date, '00:00', m.time_zone); const to = localToInstant(addDays(date, 1), '00:00', m.time_zone);
    const load = (await c.query(`SELECT count(*)::int AS n FROM appointments WHERE diary_id = $1 AND status = ANY($4) AND starts_at >= $2 AND starts_at < $3`, [m.id, from, to, ACTIVE])).rows[0].n as number;
    candidates.push({ m, load });
  }
  return candidates.sort((a, b) => a.load - b.load || a.m.name.localeCompare(b.m.name))[0]?.m ?? null;
}

export async function book(c: pg.PoolClient, actorId: string | null, tenantId: string, e: z.infer<typeof bookSchema>, now = new Date()) {
  const d = await diaryRow(c, e.diaryId);
  if (d.tenant_id !== tenantId || !d.active) throw new AppError(404, 'Diary not found.');
  refOk(e.contactRef, 'contact reference');
  noNumber(e.note, 'note'); noNumber(e.visitAddress, 'address');
  if (e.kind === 'at_location') {
    if (!e.locationId || e.visitAddress) throw new AppError(400, 'A customer coming in needs a location and no visit address.');
    if (!(await c.query('SELECT 1 FROM locations WHERE id = $1 AND tenant_id = $2', [e.locationId, tenantId])).rowCount) throw new AppError(404, 'Location not found.');
    if (e.travelMinutes) throw new AppError(400, 'Travel time belongs to a field visit.');
  } else if (!e.visitAddress || e.locationId) throw new AppError(400, 'A field visit needs the customer\'s address and no location.');
  if (e.caseId && !(await c.query('SELECT 1 FROM cases WHERE id = $1 AND tenant_id = $2', [e.caseId, tenantId])).rowCount) throw new AppError(404, 'Case not found.');
  const start = new Date(e.startsAt);
  const target = await chooseDiary(c, d, start, e.durationMinutes, e.travelMinutes, now);
  if (!target) throw new AppError(409, 'That time is not free: it is outside the diary\'s hours, in the past, or clashes with another appointment, a journey or time off.');
  const policy = await getPolicy(c, tenantId);
  const channel = e.customerChannel ?? policy.customerChannel;
  const r = (await c.query(
    `INSERT INTO appointments (tenant_id, diary_id, booked_via, case_id, contact_ref, customer_channel, kind, location_id, visit_address, travel_minutes, starts_at, ends_at, original_starts_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$13) RETURNING *`,
    [tenantId, target.id, d.kind === 'group' ? d.id : null, e.caseId ?? null, e.contactRef, channel, e.kind, e.locationId ?? null, e.visitAddress ?? null, e.travelMinutes, start, new Date(start.getTime() + e.durationMinutes * 60_000), e.note ?? null])).rows[0] as ApptRow;
  await event(c, r.id, 'booked', { diary: target.id, via: d.kind === 'group' ? d.id : null, at: start.toISOString() }, actorId);
  await notify(c, r, target, 'customer', 'booked'); await notify(c, r, target, 'officer', 'booked');
  await audit(c, actorId, 'appointment.book', 'appointment', r.id, { kind: e.kind });
  return getAppointment(c, r.id);
}

export async function getAppointment(c: pg.PoolClient, id: string) {
  const a = (await c.query(
    `SELECT a.*, d.name AS diary_name, d.time_zone, l.name AS location_name FROM appointments a JOIN diaries d ON d.id = a.diary_id LEFT JOIN locations l ON l.id = a.location_id WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw new AppError(404, 'Appointment not found.');
  const events = (await c.query('SELECT id, kind, detail, at FROM appointment_events WHERE appointment_id = $1 ORDER BY id', [id])).rows;
  const notes = (await c.query('SELECT id, recipient_kind, channel, kind, body, status, created_at FROM notifications WHERE appointment_id = $1 ORDER BY created_at, id', [id])).rows;
  return {
    id: a.id, diaryId: a.diary_id, diary: a.diary_name, bookedVia: a.booked_via, caseId: a.case_id, contactRef: a.contact_ref, kind: a.kind, location: a.location_name, visitAddress: a.visit_address,
    travelMinutes: a.travel_minutes, startsAt: a.starts_at, endsAt: a.ends_at, originalStartsAt: a.original_starts_at, timeZone: a.time_zone, status: a.status, cancelledBy: a.cancelled_by,
    cancelReason: a.cancel_reason, fee: a.fee, feeReason: a.fee_reason, replacesId: a.replaces_id, events, notifications: notes,
  };
}

/** One diary's appointments on a local date, in order. */
export async function agenda(c: pg.PoolClient, diaryId: string, date: string) {
  const d = await diaryRow(c, diaryId);
  const from = localToInstant(date, '00:00', d.time_zone); const to = localToInstant(addDays(date, 1), '00:00', d.time_zone);
  const ids = (await membersOf(c, d)).map((m) => m.id);
  return (await c.query(
    `SELECT a.id, a.diary_id, di.name AS diary, a.contact_ref, a.kind, a.starts_at, a.ends_at, a.travel_minutes, a.status, a.fee, l.name AS location, a.visit_address
       FROM appointments a JOIN diaries di ON di.id = a.diary_id LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.diary_id = ANY($1::uuid[]) AND a.starts_at >= $2 AND a.starts_at < $3 ORDER BY a.starts_at`, [ids, from, to])).rows;
}

// ------------------------------------------------------------------------------------------------ delays, cancellations, moves
export const delaySchema = z.object({ minutes: z.number().int().min(1).max(480) }).strict();

/**
 * An officer is running late. The appointment, and every later one that day that the delay touches, moves to the
 * earliest time the officer can be there; one that would end after closing is flagged for a new time instead. Each
 * customer affected is told, and so is the officer.
 */
export async function reportDelay(c: pg.PoolClient, actorId: string | null, appointmentId: string, e: z.infer<typeof delaySchema>, now = new Date()) {
  const first = await apptRow(c, appointmentId);
  await lockDiary(c, first.diary_id);
  const a = await apptRow(c, appointmentId, true);
  if (a.status !== 'booked') throw new AppError(409, `That appointment is ${a.status.replace('_', ' ')}, so it cannot be delayed.`);
  if (a.ends_at <= now) throw new AppError(409, 'That appointment is already over.');
  const d = await diaryRow(c, a.diary_id);
  const date = localParts(a.starts_at, d.time_zone).date;
  const day = await hoursOn(c, d, date);
  const closeAt = day ? localToInstant(date, day.ends, d.time_zone) : a.ends_at;
  const from = localToInstant(date, '00:00', d.time_zone); const to = localToInstant(addDays(date, 1), '00:00', d.time_zone);
  const rows = (await c.query(`SELECT id, starts_at, ends_at, travel_minutes FROM appointments WHERE diary_id = $1 AND status = 'booked' AND starts_at >= $2 AND starts_at < $3`, [a.diary_id, from, to])).rows;
  const booked: Booked[] = rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, travelMinutes: r.travel_minutes }));
  const blocks = (await c.query('SELECT starts_at, ends_at FROM diary_blocks WHERE diary_id = $1 AND ends_at > $2 AND starts_at < $3', [a.diary_id, from, to])).rows.map((b) => ({ from: b.starts_at as Date, to: b.ends_at as Date }));
  const moves = cascade(booked, a.id, e.minutes, closeAt, blocks);
  const changed: string[] = [];
  for (const m of moves) {
    const row = await apptRow(c, m.id, true);
    if (row.status !== 'booked') continue;                       // finished or cancelled meanwhile: leave it be
    const was = row.starts_at;
    if (m.overflow) {
      await c.query(`UPDATE appointments SET status = 'needs_reschedule' WHERE id = $1 AND status = 'booked'`, [m.id]);
      await event(c, m.id, 'needs_reschedule', { reason: 'A delay earlier in the day pushes it past closing or into time off.' }, actorId);
      await notify(c, { ...row, status: 'needs_reschedule' }, d, 'customer', 'needs_new_time', { was });
      await notify(c, { ...row, status: 'needs_reschedule' }, d, 'officer', 'needs_new_time', { was });
    } else {
      await c.query(`UPDATE appointments SET starts_at = $2, ends_at = $3 WHERE id = $1 AND status = 'booked'`, [m.id, m.startsAt, m.endsAt]);
      await event(c, m.id, 'delayed', { minutes: m.shiftedMinutes, was: was.toISOString(), now: m.startsAt.toISOString() }, actorId);
      const moved = { ...row, starts_at: m.startsAt, ends_at: m.endsAt };
      await notify(c, moved, d, 'customer', 'delayed', { was, minutes: m.shiftedMinutes });
      if (m.id === a.id) await notify(c, moved, d, 'officer', 'delayed', { was, minutes: m.shiftedMinutes });
    }
    changed.push(m.id);
  }
  await audit(c, actorId, 'appointment.delay', 'appointment', a.id, { minutes: e.minutes, moved: changed.length });
  return { moved: changed.length, appointments: await Promise.all(changed.map((id) => getAppointment(c, id))) };
}

/** A customer is never charged for a time the business broke: one it delayed, or flagged for a new time. */
const brokenByBusiness = (a: ApptRow) => a.status === 'needs_reschedule' || a.starts_at.getTime() !== a.original_starts_at.getTime();

export const cancelSchema = z.object({ by: z.enum(['customer', 'officer', 'client']), reason: z.string().min(1).max(300) }).strict();

/** Cancel an appointment. A customer who cancels inside the client's free window owes the late fee; nobody else does. */
export async function cancelAppointment(c: pg.PoolClient, actorId: string | null, appointmentId: string, e: z.infer<typeof cancelSchema>, now = new Date()) {
  noNumber(e.reason, 'reason');
  const first = await apptRow(c, appointmentId);
  await lockDiary(c, first.diary_id);
  const a = await apptRow(c, appointmentId, true);
  if (!ACTIVE.includes(a.status)) throw new AppError(409, `That appointment is already ${a.status.replace('_', ' ')}.`);
  if (a.ends_at <= now) throw new AppError(409, 'That appointment is already over: mark it done, or as a no-show.');
  const d = await diaryRow(c, a.diary_id);
  const policy = await getPolicy(c, a.tenant_id);
  const { fee, reason } = feeFor(policy, { event: 'cancel', by: brokenByBusiness(a) ? 'client' : e.by, startsAt: a.starts_at, now });
  await c.query(`UPDATE appointments SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3, fee = $4, fee_reason = $5 WHERE id = $1`, [a.id, e.by, e.reason, fee, reason]);
  await event(c, a.id, 'cancelled', { by: e.by, fee, feeReason: reason }, actorId);
  await notify(c, a, d, 'customer', 'cancelled'); await notify(c, a, d, 'officer', 'cancelled');
  if (toScaled(fee) > 0n) await notify(c, a, d, 'customer', 'fee', { fee: stripZeros(fee), currency: policy.currency });
  await audit(c, actorId, 'appointment.cancel', 'appointment', a.id, { by: e.by });
  return getAppointment(c, a.id);
}

export const rescheduleSchema = z.object({ by: z.enum(['customer', 'officer', 'client']), startsAt: z.string().datetime({ offset: true }), diaryId: z.string().uuid().optional() }).strict();

/** Move an appointment to a free time (the same diary, or another or a group). The old one is closed as moved, with a fee if a customer moved it late. */
export async function reschedule(c: pg.PoolClient, actorId: string | null, appointmentId: string, e: z.infer<typeof rescheduleSchema>, now = new Date()) {
  const first = await apptRow(c, appointmentId);
  const target = e.diaryId ? await diaryRow(c, e.diaryId) : await diaryRow(c, first.diary_id);
  if (target.tenant_id !== first.tenant_id || !target.active) throw new AppError(404, 'Diary not found.');
  // Every diary this will touch, locked in one fixed order before anything else, so it cannot deadlock with another booking or move.
  await lockDiaries(c, [first.diary_id, ...(await membersOf(c, target)).map((m) => m.id)]);
  const a = await apptRow(c, appointmentId, true);
  if (!ACTIVE.includes(a.status)) throw new AppError(409, `That appointment is already ${a.status.replace('_', ' ')}.`);
  if (a.ends_at <= now) throw new AppError(409, 'That appointment is already over.');
  const start = new Date(e.startsAt); const duration = Math.round((a.ends_at.getTime() - a.starts_at.getTime()) / 60_000);
  const chosen = await chooseDiary(c, target, start, duration, a.travel_minutes, now, a.id);
  if (!chosen) throw new AppError(409, 'That time is not free.');
  const policy = await getPolicy(c, a.tenant_id);
  const { fee, reason } = feeFor(policy, { event: 'cancel', by: brokenByBusiness(a) ? 'client' : e.by, startsAt: a.starts_at, now });
  await c.query(`UPDATE appointments SET status = 'rescheduled', cancelled_by = $2, cancel_reason = 'Moved to another time.', fee = $3, fee_reason = $4 WHERE id = $1`, [a.id, e.by, fee, reason]);
  const n = (await c.query(
    `INSERT INTO appointments (tenant_id, diary_id, booked_via, case_id, contact_ref, customer_channel, kind, location_id, visit_address, travel_minutes, starts_at, ends_at, original_starts_at, replaces_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$13,$14) RETURNING *`,
    [a.tenant_id, chosen.id, target.kind === 'group' ? target.id : null, a.case_id, a.contact_ref, a.customer_channel, a.kind, a.location_id, a.visit_address, a.travel_minutes, start, new Date(start.getTime() + duration * 60_000), a.id, null])).rows[0] as ApptRow;
  await event(c, a.id, 'rescheduled', { to: n.id, by: e.by, fee, feeReason: reason }, actorId);
  await event(c, n.id, 'booked', { replaces: a.id, diary: chosen.id }, actorId);
  await notify(c, n, chosen, 'customer', 'moved', { was: a.starts_at }); await notify(c, n, chosen, 'officer', 'moved', { was: a.starts_at });
  const oldDiary = await diaryRow(c, a.diary_id);
  if (oldDiary.id !== chosen.id) await notify(c, a, oldDiary, 'officer', 'cancelled');
  if (toScaled(fee) > 0n) await notify(c, a, oldDiary, 'customer', 'fee', { fee: stripZeros(fee), currency: policy.currency });      // the fee is for the time that was given up
  await audit(c, actorId, 'appointment.reschedule', 'appointment', a.id, { by: e.by });
  return getAppointment(c, n.id);
}

/** A customer who did not come. The appointment is closed, and the client's no-show fee is recorded. */
export async function markNoShow(c: pg.PoolClient, actorId: string | null, appointmentId: string, now = new Date()) {
  const first = await apptRow(c, appointmentId);
  await lockDiary(c, first.diary_id);
  const a = await apptRow(c, appointmentId, true);
  if (a.status !== 'booked') throw new AppError(409, `That appointment is ${a.status.replace('_', ' ')}.`);
  if (a.starts_at > now) throw new AppError(409, 'That appointment has not started yet.');
  const d = await diaryRow(c, a.diary_id);
  const policy = await getPolicy(c, a.tenant_id);
  const { fee, reason } = feeFor(policy, { event: 'no_show', by: 'officer', startsAt: a.starts_at, now });
  await c.query(`UPDATE appointments SET status = 'no_show', fee = $2, fee_reason = $3 WHERE id = $1 AND status = 'booked'`, [a.id, fee, reason]);
  await event(c, a.id, 'no_show', { fee }, actorId);
  if (toScaled(fee) > 0n) await notify(c, a, d, 'customer', 'fee', { fee: stripZeros(fee), currency: policy.currency });
  await audit(c, actorId, 'appointment.no_show', 'appointment', a.id, {});
  return getAppointment(c, a.id);
}

export async function completeAppointment(c: pg.PoolClient, actorId: string | null, appointmentId: string, now = new Date()) {
  const first = await apptRow(c, appointmentId);
  await lockDiary(c, first.diary_id);
  const a = await apptRow(c, appointmentId, true);
  if (a.status !== 'booked') throw new AppError(409, `That appointment is ${a.status.replace('_', ' ')}.`);
  if (a.starts_at > now) throw new AppError(409, 'That appointment has not started yet.');
  await c.query(`UPDATE appointments SET status = 'completed' WHERE id = $1 AND status = 'booked'`, [a.id]);
  await event(c, a.id, 'completed', {}, actorId);
  await audit(c, actorId, 'appointment.complete', 'appointment', a.id, {});
  return getAppointment(c, a.id);
}

const stripZeros = (v: string) => { const [w, f = ''] = v.split('.'); const t = f.replace(/0+$/, ''); return t ? `${w}.${t.length === 1 ? `${t}0` : t}` : w!; };

// ------------------------------------------------------------------------------------------------ reminders and the outbox
/** A reminder for every appointment starting within the client's reminder window, once each. Run on a schedule. */
export async function sweepReminders(c: pg.PoolClient, tenantId: string, now = new Date()) {
  const policy = await getPolicy(c, tenantId);
  const rows = (await c.query(`SELECT * FROM appointments WHERE tenant_id = $1 AND status = 'booked' AND starts_at > $2 AND starts_at <= $3`, [tenantId, now, new Date(now.getTime() + policy.reminderHours * 3_600_000)])).rows as ApptRow[];
  let made = 0;
  for (const a of rows) {
    // One reminder per appointment: a delay already sent its own message with the new time.
    if (await notify(c, a, await diaryRow(c, a.diary_id), 'customer', 'reminder', { dedupe: 'reminder' })) made++;
  }
  return { reminders: made };
}

export const listNotifications = async (c: pg.PoolClient, tenantId: string, status = 'pending') =>
  (await c.query(
    `SELECT n.id, n.appointment_id, n.recipient_kind, n.recipient_ref, n.channel, n.kind, n.body, n.status, n.created_at FROM notifications n
      WHERE n.tenant_id = $1 AND n.status = $2 ORDER BY n.created_at, n.id LIMIT 500`, [tenantId, status])).rows;

/** The client's sender says it delivered a message (or could not). The text and recipient are never changed. */
export async function markNotification(c: pg.PoolClient, actorId: string | null, id: string, status: 'sent' | 'failed') {
  const r = (await c.query(`UPDATE notifications SET status = $2, marked_at = now() WHERE id = $1 AND status = 'pending' RETURNING appointment_id`, [id, status])).rows[0];
  if (!r) throw new AppError(409, 'That message is not waiting.');
  await event(c, r.appointment_id, `notification.${status}`, { notification: id }, actorId);
  return { status };
}

export async function appointmentSummary(c: pg.PoolClient, tenantId?: string) {
  const r = (await c.query(
    `SELECT count(*) FILTER (WHERE status = 'needs_reschedule')::int AS needs_reschedule, count(*) FILTER (WHERE status = 'booked' AND starts_at > now())::int AS upcoming
       FROM appointments WHERE ($1::uuid IS NULL OR tenant_id = $1)`, [tenantId ?? null])).rows[0];
  const unsent = (await c.query(`SELECT count(*)::int AS n FROM notifications WHERE status = 'pending' AND created_at < now() - interval '1 hour' AND ($1::uuid IS NULL OR tenant_id = $1)`, [tenantId ?? null])).rows[0].n as number;
  return { needsReschedule: r.needs_reschedule as number, upcoming: r.upcoming as number, unsentOverAnHour: unsent };
}

