/**
 * The rules of the diary, with no database and no clock of its own: which start times are free, how a delay moves the
 * appointments after it, what a late cancellation costs, and how a time is written for a person. Times in, times out.
 */
import { fromScaled, toScaled } from '../money.js';
import { localParts, localToInstant } from '../cases/policy.js';

export interface Interval { from: Date; to: Date }
const overlaps = (a: Interval, b: Interval) => a.from < b.to && b.from < a.to;
const MIN = 60_000;

/** What an existing appointment takes from its officer: the journey there, then the appointment itself. */
export const occupied = (a: { startsAt: Date; endsAt: Date; travelMinutes: number }): Interval => ({ from: new Date(a.startsAt.getTime() - a.travelMinutes * MIN), to: a.endsAt });

export interface DayHours { date: string; starts: string; ends: string; timeZone: string }

/** Does an appointment starting exactly `start` fit: inside the diary's hours, clear of everything booked or blocked (its journey counted), and not in the past? */
export function fits(o: { day: DayHours; start: Date; durationMinutes: number; travelMinutes: number; busy: Interval[]; now: Date }): boolean {
  const open = localToInstant(o.day.date, o.day.starts, o.day.timeZone); const close = localToInstant(o.day.date, o.day.ends, o.day.timeZone);
  const end = new Date(o.start.getTime() + o.durationMinutes * MIN);
  if (o.start <= o.now || o.start < open || end > close) return false;
  const take: Interval = { from: new Date(o.start.getTime() - o.travelMinutes * MIN), to: end };
  return !o.busy.some((b) => overlaps(take, b));
}

/**
 * Start times on one day when a new appointment of `durationMinutes` (with `travelMinutes` to get there) fits the
 * diary's hours, clashes with nothing already booked or blocked, and is not in the past. Offered every `stepMinutes`.
 */
export function freeStarts(o: { day: DayHours; durationMinutes: number; travelMinutes: number; busy: Interval[]; now: Date; stepMinutes?: number }): Date[] {
  const open = localToInstant(o.day.date, o.day.starts, o.day.timeZone); const close = localToInstant(o.day.date, o.day.ends, o.day.timeZone);
  const step = (o.stepMinutes ?? 15) * MIN; const out: Date[] = [];
  for (let t = open.getTime(); t + o.durationMinutes * MIN <= close.getTime(); t += step) {
    if (fits({ ...o, start: new Date(t) })) out.push(new Date(t));
  }
  return out;
}

export interface Booked { id: string; startsAt: Date; endsAt: Date; travelMinutes: number }
export interface Move { id: string; startsAt: Date; endsAt: Date; shiftedMinutes: number; overflow: boolean }

/**
 * An officer is running late for one appointment. It starts `delayMinutes` later, and every later appointment that day
 * starts as soon as the officer can get there from the one before, never earlier than booked. One that would finish
 * after the diary closes, or run into time off, is not moved there: it is flagged for a new time and taken out of the
 * chain, so the appointments after it are judged only by what actually happens before them. Only appointments that
 * change are returned.
 */
export function cascade(day: Booked[], delayedId: string, delayMinutes: number, closeAt: Date, blocks: Interval[] = []): Move[] {
  const sorted = [...day].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const i = sorted.findIndex((a) => a.id === delayedId);
  if (i < 0 || delayMinutes <= 0) return [];
  const moves: Move[] = [];
  let prevEnd = (i > 0 ? sorted[i - 1]!.endsAt : null) as Date | null;       // the officer is free after the last appointment that is not affected
  for (let k = i; k < sorted.length; k++) {
    const a = sorted[k]!; const length = a.endsAt.getTime() - a.startsAt.getTime();
    const earliest: number = k === i ? a.startsAt.getTime() + delayMinutes * MIN : Math.max(a.startsAt.getTime(), (prevEnd?.getTime() ?? 0) + a.travelMinutes * MIN);
    const startsAt = new Date(earliest); const endsAt = new Date(earliest + length);
    const take: Interval = { from: new Date(earliest - a.travelMinutes * MIN), to: endsAt };
    if (endsAt > closeAt || blocks.some((b) => overlaps(take, b))) {
      moves.push({ id: a.id, startsAt: a.startsAt, endsAt: a.endsAt, shiftedMinutes: 0, overflow: true });
      continue;
    }
    if (startsAt.getTime() === a.startsAt.getTime()) break;        // this one is not moved, so nothing after it is
    prevEnd = endsAt;
    moves.push({ id: a.id, startsAt, endsAt, shiftedMinutes: Math.round((earliest - a.startsAt.getTime()) / MIN), overflow: false });
  }
  return moves;
}

export interface FeePolicy { freeUntilHours: number; lateFee: string; noShowFee: string }

/** What cancelling or missing an appointment costs the customer under the client's policy. Only a customer's own late cancellation or no-show costs anything. */
export function feeFor(policy: FeePolicy, e: { event: 'cancel' | 'no_show'; by: 'customer' | 'officer' | 'client'; startsAt: Date; now: Date }): { fee: string; reason: string | null } {
  const none = { fee: fromScaled(0n), reason: null };
  if (e.event === 'no_show') return toScaled(policy.noShowFee) > 0n ? { fee: fromScaled(toScaled(policy.noShowFee)), reason: 'The customer did not turn up.' } : none;
  if (e.by !== 'customer') return none;
  const hoursAhead = (e.startsAt.getTime() - e.now.getTime()) / 3_600_000;
  return hoursAhead < policy.freeUntilHours && toScaled(policy.lateFee) > 0n
    ? { fee: fromScaled(toScaled(policy.lateFee)), reason: `Cancelled less than ${policy.freeUntilHours} hours before the appointment.` } : none;
}

/** A time for a person, in their zone, with no run of digits and dashes that could be mistaken for a phone number: "Thu 15 Oct, 14:35". */
export function whenText(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('weekday')} ${g('day')} ${g('month')}, ${g('hour')}:${g('minute')}`;
}

export const dayOf = (at: Date, timeZone: string): { date: string; dow: number } => { const p = localParts(at, timeZone); return { date: p.date, dow: p.dow }; };

export type MessageKind = 'booked' | 'moved' | 'delayed' | 'cancelled' | 'reminder' | 'needs_new_time' | 'fee';
/** The words of a message about an appointment. Plain and short; the client's sender delivers them. */
export function messageFor(kind: MessageKind, d: { when: string; was?: string; where: string; minutes?: number; fee?: string; currency?: string; for: 'customer' | 'officer' }): string {
  const who = d.for === 'officer' ? 'Appointment' : 'Your appointment';
  switch (kind) {
    case 'booked': return `${who} booked for ${d.when}, ${d.where}.`;
    case 'moved': return `${who} has moved from ${d.was} to ${d.when}, ${d.where}.`;
    case 'delayed': return d.for === 'officer' ? `Running ${d.minutes} minutes late: the appointment moves from ${d.was} to ${d.when}, ${d.where}.` : `We are sorry: your appointment is delayed by ${d.minutes} minutes and now starts at ${d.when}, ${d.where}.`;
    case 'cancelled': return `${who} on ${d.when} has been cancelled.`;
    case 'reminder': return `Reminder: ${d.for === 'officer' ? 'appointment' : 'your appointment'} on ${d.when}, ${d.where}.`;
    case 'needs_new_time': return `${who} on ${d.was} cannot go ahead at its time because of a delay earlier in the day. A new time will be arranged.`;
    case 'fee': return `A fee of ${d.fee} ${d.currency} applies to the appointment on ${d.when}.`;
  }
}
