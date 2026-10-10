import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localParts, localToInstant } from '../src/cases/policy.js';
import { redactNumbers } from '../src/telephony/types.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let otherTenantId: string; let otherBranch: string; let branch: string; let officerA: string; let officerB: string; let team: string;
const KL = 'Asia/Kuala_Lumpur';
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

const dayPlus = (n: number) => addDays(localParts(new Date(), KL).date, n);
const at = (date: string, hhmm: string) => localToInstant(date, hhmm, KL).toISOString();
let seq = 0;
const visit = (diaryId: string, date: string, hhmm: string, o: object = {}) => post(`/internal/tenants/${tenantId}/appointments`, {
  diaryId, contactRef: `cust-${++seq}`, kind: 'field_visit', visitAddress: '12 Jalan Ampang, Kuala Lumpur', travelMinutes: 15, startsAt: at(date, hhmm), durationMinutes: 45, ...o });
const comeIn = (diaryId: string, date: string, hhmm: string, o: object = {}) => post(`/internal/tenants/${tenantId}/appointments`, {
  diaryId, contactRef: `cust-${++seq}`, kind: 'at_location', locationId: branch, startsAt: at(date, hhmm), durationMinutes: 30, ...o });
const appt = async (id: string) => (await get(`/internal/appointments/${id}`)).json();
const notes = async (id: string) => (await appt(id)).notifications as { recipient_kind: string; kind: string; body: string; channel: string; status: string }[];

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Appt Co' }))).json().id;
  otherTenantId = (await must(post('/internal/tenants', { name: 'Other Co' }))).json().id;
  branch = (await must(post(`/internal/tenants/${tenantId}/locations`, { name: 'Cheras branch', address: '88 Jalan Cheras, Kuala Lumpur' }))).json().id;
  otherBranch = (await must(post(`/internal/tenants/${otherTenantId}/locations`, { name: 'Other branch', address: '1 Jalan Lain' }))).json().id;
  const mk = async (name: string, ref: string) => (await must(post(`/internal/tenants/${tenantId}/diaries`, { name, kind: 'individual', officerRef: ref, timeZone: KL }))).json().id as string;
  officerA = await mk('Aminah', 'officer-aminah'); officerB = await mk('Bala', 'officer-bala');
  for (const d of [officerA, officerB]) await must(put(`/internal/diaries/${d}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, starts: '09:00', ends: '17:00' })) }));
  team = (await must(post(`/internal/tenants/${tenantId}/diaries`, { name: 'Field team', kind: 'group', timeZone: KL, members: [officerA, officerB] }))).json().id;
  await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 24, lateFee: '25.50', noShowFee: '40', currency: 'MYR', reminderHours: 24 }));
});
afterAll(async () => { await env?.teardown(); });

describe('diaries', () => {
  it('are for one officer or for a group of them, and refuse what cannot work', async () => {
    const mk = (b: object) => post(`/internal/tenants/${tenantId}/diaries`, { name: `d${++seq}`, timeZone: KL, ...b });
    expect((await mk({ kind: 'individual' })).statusCode).toBe(400);                                         // no officer
    expect((await mk({ kind: 'individual', officerRef: '+60123456789' })).statusCode).toBe(400);              // a number is not a reference
    expect((await mk({ kind: 'individual', officerRef: 'x', timeZone: 'Nowhere/Land' })).statusCode).toBe(400);
    expect((await mk({ kind: 'group' })).statusCode).toBe(400);                                              // no members
    expect((await mk({ kind: 'group', members: [team] })).statusCode).toBe(400);                              // a group is not a member
    expect((await mk({ kind: 'group', members: [crypto.randomUUID()] })).statusCode).toBe(400);
    expect((await put(`/internal/diaries/${officerA}/hours`, { hours: [{ dow: 1, starts: '17:00', ends: '09:00' }] })).statusCode).toBe(400);
    expect((await put(`/internal/diaries/${team}/hours`, { hours: [] })).statusCode).toBe(400);               // a group offers its members' hours
    const g = (await get(`/internal/diaries/${team}`)).json();
    expect(g).toMatchObject({ kind: 'group' }); expect(g.members.map((m: { name: string }) => m.name)).toEqual(['Aminah', 'Bala']);
  });
});

describe('booking', () => {
  it('offers the free times of a diary, books one, and then no longer offers it', async () => {
    const date = dayPlus(3);
    const slots = async () => ((await get(`/internal/diaries/${officerA}/slots?date=${date}&durationMinutes=30`)).json() as { startsAt: string }[]).map((s) => s.startsAt);
    const before = await slots();
    expect(before[0]).toBe(at(date, '09:00')); expect(before.at(-1)).toBe(at(date, '16:30'));
    const r = await must(comeIn(officerA, date, '10:00'));
    expect(r.json()).toMatchObject({ status: 'booked', kind: 'at_location', location: 'Cheras branch', diary: 'Aminah' });
    const after = await slots();
    expect(after).not.toContain(at(date, '10:00')); expect(after).not.toContain(at(date, '09:45')); expect(after).toContain(at(date, '09:30')); expect(after).toContain(at(date, '10:30'));
    expect((await comeIn(officerA, date, '10:15')).statusCode).toBe(409);                                    // overlaps
    expect((await comeIn(officerA, date, '16:45')).statusCode).toBe(409);                                    // runs past closing
    expect((await comeIn(officerA, date, '08:00')).statusCode).toBe(409);                                    // before opening
    expect((await comeIn(officerA, dayPlus(-1), '10:00')).statusCode).toBe(409);                              // in the past
  });

  it('lets only one of two simultaneous bookings for the same time through', async () => {
    const date = dayPlus(4);
    const out = await Promise.all([comeIn(officerB, date, '11:00'), comeIn(officerB, date, '11:00'), comeIn(officerB, date, '11:15')]);
    expect(out.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(out.filter((r) => r.statusCode === 409)).toHaveLength(2);
  });

  it('puts a group booking on the least busy member who is free, and refuses when none is', async () => {
    const date = dayPlus(5);
    const first = (await must(comeIn(team, date, '10:00'))).json();
    const second = (await must(comeIn(team, date, '10:00'))).json();
    expect(first.bookedVia).toBe(team); expect(new Set([first.diaryId, second.diaryId]).size).toBe(2);        // two members, one each
    expect((await comeIn(team, date, '10:00')).statusCode).toBe(409);                                         // both busy
    const slots = (await get(`/internal/diaries/${team}/slots?date=${date}&durationMinutes=30`)).json() as { startsAt: string; diaries: string[] }[];
    expect(slots.find((s) => s.startsAt === at(date, '09:00'))!.diaries).toHaveLength(2);
    expect(slots.find((s) => s.startsAt === at(date, '10:00'))).toBeUndefined();
  });

  it('counts the journey to a field visit, and the time off of an officer', async () => {
    const date = dayPlus(6);
    await must(visit(officerA, date, '10:00', { durationMinutes: 30, travelMinutes: 0 }));                       // 10:00 to 10:30
    expect((await visit(officerA, date, '10:45', { travelMinutes: 30 })).statusCode).toBe(409);                  // would have to leave at 10:15
    await must(visit(officerA, date, '11:00', { travelMinutes: 30 }));                                           // leaves at 10:30
    const block = await post(`/internal/diaries/${officerA}/blocks`, { startsAt: at(date, '10:00'), endsAt: at(date, '10:30'), reason: 'Training' });
    expect(block.statusCode).toBe(409);                                                                          // over a booked appointment
    await must(post(`/internal/diaries/${officerA}/blocks`, { startsAt: at(date, '14:00'), endsAt: at(date, '15:00'), reason: 'Training' }));
    expect((await comeIn(officerA, date, '14:30')).statusCode).toBe(409);
    const slots = ((await get(`/internal/diaries/${officerA}/slots?date=${date}&durationMinutes=30`)).json() as { startsAt: string }[]).map((s) => s.startsAt);
    expect(slots).not.toContain(at(date, '14:00')); expect(slots).toContain(at(date, '15:00'));
  });

  it('needs a location for a customer who comes in, an address for a visit, and keeps numbers out of everything it stores', async () => {
    const date = dayPlus(7);
    const raw = (b: object) => post(`/internal/tenants/${tenantId}/appointments`, { diaryId: officerB, contactRef: 'c1', startsAt: at(date, '09:00'), durationMinutes: 30, ...b });
    expect((await raw({ kind: 'at_location' })).statusCode).toBe(400);
    expect((await raw({ kind: 'at_location', locationId: branch, visitAddress: 'x' })).statusCode).toBe(400);
    expect((await raw({ kind: 'field_visit' })).statusCode).toBe(400);
    expect((await raw({ kind: 'at_location', locationId: branch, travelMinutes: 10 })).statusCode).toBe(400);
    expect((await raw({ kind: 'at_location', locationId: branch, contactRef: '+60123456789' })).statusCode).toBe(400);
    expect((await raw({ kind: 'field_visit', visitAddress: 'call 012-345 6789 at the gate' })).statusCode).toBe(400);
    expect((await raw({ kind: 'at_location', locationId: branch, note: 'ring +60123456789' })).statusCode).toBe(400);
    expect((await post(`/internal/tenants/${otherTenantId}/appointments`, { diaryId: officerB, contactRef: 'c', kind: 'at_location', locationId: otherBranch, startsAt: at(date, '09:00'), durationMinutes: 30 })).statusCode).toBe(404);   // another client's diary, with a location of its own
    const ok = await must(raw({ kind: 'at_location', locationId: branch }));
    expect(JSON.stringify(ok.json())).not.toMatch(/\+60|012-345/);
  });
});

describe('a delay moves what follows', () => {
  it('pushes each later visit that day as far as it must, tells each customer and the officer, and leaves the rest alone', async () => {
    const date = dayPlus(8);
    const a = (await must(visit(officerA, date, '09:00', { travelMinutes: 0 }))).json();
    const b = (await must(visit(officerA, date, '10:00'))).json();
    const c = (await must(visit(officerA, date, '11:00'))).json();
    const d = (await must(visit(officerA, date, '15:00'))).json();
    const out = (await must(post(`/internal/appointments/${a.id}/delay`, { minutes: 20 }))).json();
    expect(out.moved).toBe(3);
    expect((await appt(a.id)).startsAt).toBe(at(date, '09:20')); expect((await appt(b.id)).startsAt).toBe(at(date, '10:20')); expect((await appt(c.id)).startsAt).toBe(at(date, '11:20'));
    expect((await appt(d.id)).startsAt).toBe(at(date, '15:00'));                                                  // absorbed by the afternoon gap
    expect((await appt(b.id)).originalStartsAt).toBe(at(date, '10:00'));
    const cust = (await notes(b.id)).filter((n) => n.kind === 'delayed');
    expect(cust).toHaveLength(1);
    expect(cust[0]).toMatchObject({ recipient_kind: 'customer', channel: 'whatsapp' });
    expect(cust[0]!.body).toContain('delayed by 20 minutes'); expect(cust[0]!.body).toContain('10:20');
    expect((await notes(a.id)).some((n) => n.kind === 'delayed' && n.recipient_kind === 'officer')).toBe(true);
    expect((await notes(d.id)).some((n) => n.kind === 'delayed')).toBe(false);
    expect((await appt(b.id)).events.map((e: { kind: string }) => e.kind)).toEqual(['booked', 'delayed']);
    expect((await post(`/internal/appointments/${a.id}/delay`, { minutes: 0 })).statusCode).toBe(400);
  });

  it('flags an appointment a delay would push past closing for a new time, and says so to its customer and the officer', async () => {
    const date = dayPlus(9);
    const a = (await must(visit(officerB, date, '15:00', { travelMinutes: 0 }))).json();
    const b = (await must(visit(officerB, date, '16:00'))).json();
    await must(post(`/internal/appointments/${a.id}/delay`, { minutes: 30 }));                                   // a ends 16:15, b cannot be there before 16:30 and would end 17:15
    expect((await appt(a.id)).status).toBe('booked');
    expect((await appt(b.id)).status).toBe('needs_reschedule');
    expect((await notes(b.id)).filter((n) => n.kind === 'needs_new_time').map((n) => n.recipient_kind).sort()).toEqual(['customer', 'officer']);
    expect((await post(`/internal/appointments/${b.id}/delay`, { minutes: 5 })).statusCode).toBe(409);            // already waiting for a new time
    const alerts = (await get('/internal/control-tower')).json().alerts as { code: string }[];
    expect(alerts.map((x) => x.code)).toContain('appointments_rebook');
    // and a new time can be given
    const moved = (await must(post(`/internal/appointments/${b.id}/reschedule`, { by: 'client', startsAt: at(dayPlus(10), '09:00') }))).json();
    expect(moved).toMatchObject({ status: 'booked', replacesId: b.id });
  });
});

describe('cancelling and moving', () => {
  it('charges a customer who cancels inside the free window the late fee, in exact money, and nobody else', async () => {
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 720 }));              // everything in the next 30 days is "late"
    const a = (await must(comeIn(officerA, dayPlus(11), '09:00'))).json();
    const late = (await must(post(`/internal/appointments/${a.id}/cancel`, { by: 'customer', reason: 'Cannot make it' }))).json();
    expect(late).toMatchObject({ status: 'cancelled', cancelledBy: 'customer', fee: '25.50000000' });
    expect(late.feeReason).toContain('720 hours');
    expect((await notes(a.id)).find((n) => n.kind === 'fee')!.body).toBe(`A fee of 25.50 MYR applies to the appointment on ${(await notes(a.id))[0]!.body.match(/for (.*), at/)![1]}.`);
    const b = (await must(comeIn(officerA, dayPlus(11), '09:00'))).json();                                      // the time is free again
    expect((await must(post(`/internal/appointments/${b.id}/cancel`, { by: 'officer', reason: 'Officer unwell' }))).json().fee).toBe('0.00000000');
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 24 }));
    const far = (await must(comeIn(officerA, dayPlus(40), '09:00'))).json();
    expect((await must(post(`/internal/appointments/${far.id}/cancel`, { by: 'customer', reason: 'Changed my mind' }))).json().fee).toBe('0.00000000');
    expect((await post(`/internal/appointments/${far.id}/cancel`, { by: 'customer', reason: 'again' })).statusCode).toBe(409);
    expect((await post(`/internal/appointments/${far.id}/cancel`, { by: 'customer', reason: 'ring +60123456789' })).statusCode).toBe(400);
  });

  it('moves an appointment to a free time, links the new one to the old, and charges a late move like a late cancellation', async () => {
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 720 }));
    const date = dayPlus(12);
    const a = (await must(comeIn(officerA, date, '09:00'))).json();
    await must(comeIn(officerA, date, '10:00'));
    expect((await post(`/internal/appointments/${a.id}/reschedule`, { by: 'customer', startsAt: at(date, '10:00') })).statusCode).toBe(409);       // taken
    const moved = (await must(post(`/internal/appointments/${a.id}/reschedule`, { by: 'customer', startsAt: at(date, '13:00'), diaryId: officerB }))).json();
    expect(moved).toMatchObject({ status: 'booked', replacesId: a.id, diary: 'Bala', startsAt: at(date, '13:00') });
    expect(await appt(a.id)).toMatchObject({ status: 'rescheduled', fee: '25.50000000' });
    expect((await notes(moved.id)).filter((n) => n.kind === 'moved').map((n) => n.recipient_kind).sort()).toEqual(['customer', 'officer']);
    expect((await notes(a.id)).some((n) => n.kind === 'cancelled' && n.recipient_kind === 'officer')).toBe(true);                                       // the first officer is told it is gone
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 24 }));
  });

  it('records a no-show with the client\'s fee, but only after the appointment has started', async () => {
    const a = (await must(comeIn(officerB, dayPlus(13), '09:00'))).json();
    expect((await post(`/internal/appointments/${a.id}/no-show`)).statusCode).toBe(409);                           // not started
    await env.pool.query(`UPDATE appointments SET starts_at = starts_at - interval '20 days', ends_at = ends_at - interval '20 days' WHERE id = $1`, [a.id]);    // time passes
    expect((await must(post(`/internal/appointments/${a.id}/no-show`))).json()).toMatchObject({ status: 'no_show', fee: '40.00000000' });
    const b = (await must(comeIn(officerB, dayPlus(13), '10:00'))).json();
    await env.pool.query(`UPDATE appointments SET starts_at = starts_at - interval '20 days', ends_at = ends_at - interval '20 days' WHERE id = $1`, [b.id]);
    expect((await must(post(`/internal/appointments/${b.id}/complete`))).json()).toMatchObject({ status: 'completed', fee: '0.00000000' });
  });
});

describe('messages for people', () => {
  it('go to the channel each prefers by the client\'s reference, never carry a number, and are marked delivered once', async () => {
    const r = (await must(comeIn(officerA, dayPlus(14), '09:00', { customerChannel: 'email', contactRef: 'cust-mail' }))).json();
    const list = (await get(`/internal/tenants/${tenantId}/notifications`)).json() as { id: string; appointment_id: string; recipient_ref: string; channel: string; body: string }[];
    const mine = list.filter((n) => n.appointment_id === r.id);
    expect(mine.map((n) => [n.recipient_ref, n.channel]).sort()).toEqual([['cust-mail', 'email'], ['officer-aminah', 'whatsapp']]);
    for (const n of list) expect(redactNumbers(n.body)).toBe(n.body);
    expect((await must(post(`/internal/notifications/${mine[0]!.id}/mark`, { status: 'sent' }))).json()).toEqual({ status: 'sent' });
    expect((await post(`/internal/notifications/${mine[0]!.id}/mark`, { status: 'sent' })).statusCode).toBe(409);
    await expect(env.pool.query(`UPDATE notifications SET body = 'x' WHERE id = $1`, [mine[0]!.id])).rejects.toThrow(/only its status changes/);   // the text and the recipient never change
    await expect(env.pool.query(`DELETE FROM notifications WHERE id = $1`, [mine[0]!.id])).rejects.toThrow(/append-only/);
    expect(((await get(`/internal/tenants/${tenantId}/notifications?status=sent`)).json() as { id: string }[]).map((n) => n.id)).toContain(mine[0]!.id);
  });

  it('remind a customer once, shortly before the appointment', async () => {
    const date = dayPlus(15);
    const r = (await must(comeIn(officerB, date, '09:00'))).json();
    await env.pool.query(`UPDATE appointments SET starts_at = now() + interval '5 hours', ends_at = now() + interval '5 hours 30 minutes' WHERE id = $1`, [r.id]);        // it is now soon
    const first = (await must(post(`/internal/tenants/${tenantId}/appointments/sweep-reminders`))).json();
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    expect((await notes(r.id)).filter((n) => n.kind === 'reminder')).toHaveLength(1);
    await must(post(`/internal/tenants/${tenantId}/appointments/sweep-reminders`));
    expect((await notes(r.id)).filter((n) => n.kind === 'reminder')).toHaveLength(1);
  });
});

describe('what stays private and what cannot be rewritten', () => {
  it('never rewrites an appointment\'s history', async () => {
    await expect(env.pool.query(`UPDATE appointment_events SET kind = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM appointment_events')).rejects.toThrow(/append-only/);
  });
});

describe('what the independent review found', () => {
  const statuses = (rs: { statusCode: number }[]) => rs.map((r) => r.statusCode);

  it('does not deadlock when a move into a group meets group bookings, or two moves cross', async () => {
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const date = dayPlus(20 + i);
      const mine = (await must(comeIn(officerB, date, '09:00'))).json();
      const rs = await Promise.all([post(`/internal/appointments/${mine.id}/reschedule`, { by: 'client', startsAt: at(date, '13:00'), diaryId: team }), comeIn(team, date, '13:00'), comeIn(team, date, '13:00')]);
      out.push(...statuses(rs));
    }
    expect(out.every((n) => n === 200 || n === 201 || n === 409)).toBe(true);                                       // never a 500
    const date = dayPlus(26);
    const x = (await must(comeIn(officerA, date, '10:00'))).json(); const y = (await must(comeIn(officerB, date, '11:00'))).json();
    const crossed = await Promise.all([post(`/internal/appointments/${x.id}/reschedule`, { by: 'client', startsAt: at(date, '14:00'), diaryId: officerB }), post(`/internal/appointments/${y.id}/reschedule`, { by: 'client', startsAt: at(date, '15:00'), diaryId: officerA })]);
    expect(statuses(crossed)).toEqual([200, 200]);
  });

  it('does not push an appointment into the officer\'s time off, and does not flag one the delay never reaches', async () => {
    const date = dayPlus(27);
    const a = (await must(visit(officerA, date, '11:00', { durationMinutes: 30, travelMinutes: 0 }))).json();
    await must(post(`/internal/diaries/${officerA}/blocks`, { startsAt: at(date, '12:00'), endsAt: at(date, '13:00'), reason: 'Prayers and lunch' }));
    await must(post(`/internal/appointments/${a.id}/delay`, { minutes: 45 }));                                        // would be 11:45 to 12:15
    expect((await appt(a.id)).status).toBe('needs_reschedule');
    const date2 = dayPlus(28);
    const first = (await must(visit(officerA, date2, '09:00', { durationMinutes: 30, travelMinutes: 0 }))).json();
    const late = (await must(visit(officerA, date2, '16:00', { durationMinutes: 30 }))).json();
    await must(post(`/internal/appointments/${first.id}/delay`, { minutes: 480 }));                                   // sends the first past closing
    expect((await appt(first.id)).status).toBe('needs_reschedule');
    expect((await appt(late.id)).status).toBe('booked');                                                               // untouched, and not told otherwise
    expect((await notes(late.id)).some((n) => n.kind === 'needs_new_time')).toBe(false);
  });

  it('never charges a customer for a time the business broke', async () => {
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 720, lateFee: '10' }));
    const date = dayPlus(29);
    const a = (await must(visit(officerB, date, '15:00', { travelMinutes: 0 }))).json();
    const b = (await must(visit(officerB, date, '16:00'))).json();
    await must(post(`/internal/appointments/${a.id}/delay`, { minutes: 30 }));
    expect((await appt(b.id)).status).toBe('needs_reschedule');
    expect((await must(post(`/internal/appointments/${b.id}/cancel`, { by: 'customer', reason: 'Cannot wait' }))).json().fee).toBe('0.00000000');   // flagged by the business
    const c = (await must(visit(officerB, dayPlus(30), '09:00', { travelMinutes: 0 }))).json();
    const d = (await must(visit(officerB, dayPlus(30), '10:00'))).json();
    await must(post(`/internal/appointments/${c.id}/delay`, { minutes: 30 }));
    expect((await must(post(`/internal/appointments/${d.id}/reschedule`, { by: 'customer', startsAt: at(dayPlus(31), '10:00') }))).json().replacesId).toBe(d.id);
    expect((await appt(d.id)).fee).toBe('0.00000000');                                                                // delayed by the business
    const own = (await must(visit(officerB, dayPlus(18), '09:00'))).json();
    expect((await must(post(`/internal/appointments/${own.id}/cancel`, { by: 'customer', reason: 'Busy' }))).json().fee).toBe('10.00000000');           // its own cancellation is charged
    await must(put(`/internal/tenants/${tenantId}/cancellation-policy`, { freeUntilHours: 24, lateFee: '25.50' }));
  });

  it('counts a group member\'s load by their own calendar day', async () => {
    const mk = async (name: string, ref: string) => (await must(post(`/internal/tenants/${tenantId}/diaries`, { name, kind: 'individual', officerRef: ref, timeZone: KL }))).json().id as string;
    const c = await mk('Early C', 'officer-c'); const d = await mk('Early D', 'officer-d');
    for (const x of [c, d]) await must(put(`/internal/diaries/${x}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, starts: '06:00', ends: '17:00' })) }));
    const grp = (await must(post(`/internal/tenants/${tenantId}/diaries`, { name: 'Early team', kind: 'group', timeZone: KL, members: [c, d] }))).json().id as string;
    const date = dayPlus(33);
    for (const t of ['06:00', '06:30', '07:00']) await must(comeIn(c, date, t, { durationMinutes: 20 }));                // 22:00 to 23:00 UTC the day before: the same local day
    await must(comeIn(d, date, '10:00'));
    const booked = (await must(comeIn(grp, date, '12:00'))).json();
    expect(booked.diaryId).toBe(d);                                                                                    // D has one that day, C has three
  });

  it('will not delay, cancel or move an appointment that is already over, and will not strand a booking by changing hours', async () => {
    const r = (await must(comeIn(officerA, dayPlus(34), '09:00'))).json();
    await env.pool.query(`UPDATE appointments SET starts_at = starts_at - interval '40 days', ends_at = ends_at - interval '40 days' WHERE id = $1`, [r.id]);
    expect((await post(`/internal/appointments/${r.id}/delay`, { minutes: 10 })).statusCode).toBe(409);
    expect((await post(`/internal/appointments/${r.id}/cancel`, { by: 'customer', reason: 'late' })).statusCode).toBe(409);
    expect((await post(`/internal/appointments/${r.id}/reschedule`, { by: 'customer', startsAt: at(dayPlus(35), '09:00') })).statusCode).toBe(409);
    await must(comeIn(officerA, dayPlus(36), '09:00'));
    expect((await put(`/internal/diaries/${officerA}/hours`, { hours: [] })).statusCode).toBe(409);                    // would leave that booking with no hours
    expect((await put(`/internal/diaries/${officerA}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, starts: '09:00', ends: '17:00' })) })).statusCode).toBe(200);
  });

  it('refuses to move an appointment into an inactive diary, and sends one reminder even after a delay', async () => {
    const inactive = (await must(post(`/internal/tenants/${tenantId}/diaries`, { name: 'Retired', kind: 'individual', officerRef: 'officer-old', timeZone: KL }))).json().id as string;
    await env.pool.query('UPDATE diaries SET active = false WHERE id = $1', [inactive]);
    const date = dayPlus(37);
    const a = (await must(comeIn(officerA, date, '09:00'))).json();
    expect((await post(`/internal/appointments/${a.id}/reschedule`, { by: 'client', startsAt: at(date, '10:00'), diaryId: inactive })).statusCode).toBe(404);
    const v = (await must(visit(officerB, dayPlus(38), '09:00', { travelMinutes: 0 }))).json();
    await env.pool.query(`UPDATE appointments SET starts_at = now() + interval '6 hours', ends_at = now() + interval '6 hours 45 minutes', original_starts_at = now() + interval '6 hours' WHERE id = $1`, [v.id]);
    await must(post(`/internal/tenants/${tenantId}/appointments/sweep-reminders`));
    await must(post(`/internal/appointments/${v.id}/delay`, { minutes: 15 }));
    const again = (await must(post(`/internal/tenants/${tenantId}/appointments/sweep-reminders`))).json();
    expect((await notes(v.id)).filter((n) => n.kind === 'reminder')).toHaveLength(1);
    expect(again.reminders).toBeGreaterThanOrEqual(0);
  });
});
