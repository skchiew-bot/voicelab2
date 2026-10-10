/**
 * The rules of case management, with no database and no clock of their own: when a contact may be called, how long to
 * wait before trying again, when they are easiest to reach, which channel to try next, and what was arranged, read
 * back in plain words. Everything that depends on the time takes it as an argument.
 */
import { fromScaled, toScaled } from '../money.js';

export const isValidZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz.length > 0 && tz.length <= 60; } catch { return false; }
};

export interface LocalParts { date: string; hour: number; minute: number; dow: number }

/** The wall-clock time in a zone: its date (YYYY-MM-DD), hour, minute and day of the week (0 = Sunday). */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')), dow };
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this moment inside the quiet hours? The window may wrap midnight (21:00 to 08:00). Start is quiet, end is not. */
export function inQuietHours(at: Date, timeZone: string, start: string, end: string): boolean {
  const p = localParts(at, timeZone);
  const now = p.hour * 60 + p.minute; const s = minutesOf(start); const e = minutesOf(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The first moment at or after `at` that is not quiet, stepping a minute at a time (a window is never longer than a day). */
export function nextAllowed(at: Date, timeZone: string, start: string, end: string): Date {
  let t = new Date(at.getTime());
  for (let i = 0; i < 24 * 60 + 1 && inQuietHours(t, timeZone, start, end); i++) t = new Date(t.getTime() + 60_000);
  return t;
}

export interface Window { dayCount: number; weekCount: number; lastAt: Date | null }
export interface ContactLimits { maxPerDay: number; maxPerWeek: number; minGapMinutes: number }

/** How long until another call to this contact is allowed, or null if one is allowed now. */
export function waitForLimits(now: Date, w: Window, l: ContactLimits): { until: Date; reason: 'daily_limit' | 'weekly_limit' | 'minimum_gap' } | null {
  if (w.lastAt && l.minGapMinutes > 0) {
    const until = new Date(w.lastAt.getTime() + l.minGapMinutes * 60_000);
    if (until > now) return { until, reason: 'minimum_gap' };
  }
  if (w.dayCount >= l.maxPerDay) return { until: new Date(now.getTime() + 60 * 60_000), reason: 'daily_limit' };
  if (w.weekCount >= l.maxPerWeek) return { until: new Date(now.getTime() + 6 * 60 * 60_000), reason: 'weekly_limit' };
  return null;
}

/** Minutes to wait before attempt number `attempt` (1 = the first retry); the last step repeats. */
export const retryDelayMinutes = (backoff: readonly number[], attempt: number): number =>
  backoff.length === 0 ? 60 : backoff[Math.min(Math.max(attempt, 1), backoff.length) - 1]!;

export interface Attempt { dow: number; hour: number; outcome: 'answered' | 'no_answer' | 'busy' | 'failed' }

/**
 * When this contact is easiest to reach: the day-and-hour slots ranked by how often they answered, with the rate
 * smoothed so one lucky answer does not outrank a slot that answered three times in four.
 */
export function bestTimesToCall(attempts: readonly Attempt[], top = 3): { dow: number; hour: number; answered: number; tried: number; score: number }[] {
  const slots = new Map<string, { dow: number; hour: number; answered: number; tried: number }>();
  for (const a of attempts) {
    if (a.outcome === 'failed') continue;                 // a call that never reached the phone says nothing about the person
    const k = `${a.dow}:${a.hour}`;
    const s = slots.get(k) ?? { dow: a.dow, hour: a.hour, answered: 0, tried: 0 };
    s.tried++; if (a.outcome === 'answered') s.answered++;
    slots.set(k, s);
  }
  return [...slots.values()].map((s) => ({ ...s, score: Math.round(((s.answered + 1) / (s.tried + 2)) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || b.tried - a.tried || a.dow - b.dow || a.hour - b.hour).slice(0, top);
}

/** Which channel to use after `failures` unanswered tries in a row: the next one in the list for each `rotateAfter` failures. */
export function channelFor(channels: readonly string[], failures: number, rotateAfter: number): string {
  return channels[Math.min(Math.floor(failures / Math.max(rotateAfter, 1)), channels.length - 1)]!;
}

/** The treatment level after a broken promise: one firmer, up to the last. */
export const nextTreatment = (level: number, levels: number): number => Math.min(level + 1, Math.max(levels - 1, 0));

export const wholeDaysBetween = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** An exact decimal string trimmed for speech: "350.00000000" becomes "350", "12.50000000" becomes "12.50". */
export function plainAmount(v: string): string {
  const [whole, frac = ''] = v.split('.');
  const f = frac.replace(/0+$/, '');
  return f === '' ? whole! : `${whole}.${f.length === 1 ? `${f}0` : f}`;
}

/** The balance after payments, exactly. Never below zero. */
export function balanceAfter(opening: string, paid: string): string {
  const b = toScaled(opening) - toScaled(paid);
  return fromScaled(b < 0n ? 0n : b);
}

export interface Arrangement { currency: string; balance: string; promise?: { amount: string; dueOn: string } | null; callback?: { at: string; timeZone: string } | null }

/**
 * What was arranged, read back to the person in plain words. Built from the case's own records so it always says what
 * is on file, and contains no personal detail beyond amounts and dates.
 */
export function readBack(a: Arrangement): string {
  const parts: string[] = [];
  if (a.promise) parts.push(`You have agreed to pay ${plainAmount(a.promise.amount)} ${a.currency} by ${a.promise.dueOn}.`);
  if (a.callback) {
    const p = localParts(new Date(a.callback.at), a.callback.timeZone);
    const hh = String(p.hour).padStart(2, '0'); const mm = String(p.minute).padStart(2, '0');
    parts.push(`We will call you back on ${p.date} at ${hh}:${mm}.`);
  }
  parts.push(`The balance now is ${plainAmount(a.balance)} ${a.currency}.`);
  return parts.join(' ');
}

/** The instant at which a zone's wall clock shows the given date (YYYY-MM-DD) and time (HH:MM). */
export function localToInstant(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone);
    guess += target - Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)), p.hour, p.minute);
  }
  return new Date(guess);
}

/** The calendar date (YYYY-MM-DD) `days` after another date. */
export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
