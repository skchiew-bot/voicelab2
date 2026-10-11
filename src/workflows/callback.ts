import type { Json } from './definition.js';

/**
 * Reading a callback time the caller gave, by fixed rules (no model): a day of the week and an hour, as the outbound
 * analytics count them (day 0 = Sunday, hour 0 to 23, in a named time zone). Only these two small numbers ever leave
 * here, so whatever else the caller said, a phone number included, is never recorded with them. Anything the rules
 * cannot read gives null: an unknown time is recorded as unknown, never guessed.
 */

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0, ahad: 0, // not "minggu": in Malay it is also "week"
  monday: 1, mon: 1, isnin: 1,
  tuesday: 2, tue: 2, tues: 2, selasa: 2,
  wednesday: 3, wed: 3, rabu: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, khamis: 4,
  friday: 5, fri: 5, jumaat: 5, jumat: 5,
  saturday: 6, sat: 6, sabtu: 6,
};

/** Speech as transcribed: lower case, single spaces, and none of the punctuation a transcript puts around words. */
const tidy = (s: string) => s.toLowerCase().replace(/[“”"'!?,;]+/g, ' ').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();

/**
 * A day of the week: its name in English or Malay ("Tuesday", "tue", "Selasa.", "hari selasa"), or 0 to 6 (0 = Sunday)
 * as a number from an integration or the starting record. A digit someone said ("3") is not a day: they may mean the 3rd.
 */
export function readDay(v: Json | undefined): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 6 ? v : null;
  if (typeof v !== 'string') return null;
  const s = tidy(v).replace(/^hari /, '');
  return Object.hasOwn(DAYS, s) ? DAYS[s]! : null;
}

/**
 * An hour of the day, 0 to 23: a number (24-hour), "15", "15:00", "3pm", "3 p.m.", "noon", "midnight", or Malay times of day
 * ("pukul 3 petang", "10 pagi", "8 malam", "1 tengah hari"), with any punctuation a transcript adds ("At 3pm."). Hours
 * said in words ("three pm") are not read. Minutes are dropped, as callback times are counted by the
 * hour. An hour from 1 to 12 with nothing to say morning or evening ("3", "10:30") could be either, so it is not read
 * unless written with a leading zero ("09", "09:30"); 0 and 13 to 23 can only mean one thing.
 */
export function readHour(v: Json | undefined): number | null {
  // A number comes from an integration or the starting record, not from speech: it is a 24-hour hour.
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 23 ? v : null;
  if (typeof v !== 'string') return null;
  const s = tidy(v).replace(/^(pukul|jam|at) /, '');
  if (['noon', 'midday', '12 noon', '12 midday', 'tengah hari', 'tengahari'].includes(s)) return 12;
  if (['midnight', '12 midnight', 'tengah malam', '12 tengah malam'].includes(s)) return 0;
  let m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    if ((m[2] !== undefined && Number(m[2]) > 59) || h > 23) return null;
    return h === 0 || h >= 13 || m[1]!.startsWith('0') ? h : null;
  }
  m = /^(\d{1,2})(?:[:.](\d{2}))? ?(am|a\.m\.?|pm|p\.m\.?|pagi|tengah hari|tengahari|petang|malam)$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  if (m[2] !== undefined && Number(m[2]) > 59) return null;
  if (h < 1 || h > 12) return null;
  switch (m[3]) {
    case 'am': case 'a.m.': case 'a.m': return h === 12 ? 0 : h;
    case 'pagi': return h === 12 ? null : h; // "12 pagi" is said for both midnight and noon
    case 'pm': case 'p.m.': case 'p.m': return h === 12 ? 12 : h + 12;
    case 'tengah hari': case 'tengahari': return h === 12 || h === 11 ? h : h <= 3 ? h + 12 : null; // around midday: 11, 12, 1 to 3
    case 'petang': return h === 12 ? 12 : h <= 7 ? h + 12 : null; // afternoon to early evening
    case 'malam': return h === 12 ? 0 : h >= 7 ? h + 12 : null;   // night: 7 to 11, and 12 is midnight
    default: return null;
  }
}

/** A callback time read from a call: both parts, or nothing. */
export interface CallbackTime { day: number; hour: number; timeZone: string }

/**
 * A time zone name in its one standard form (Asia/Kuala_Lumpur for "asia/kuala_lumpur"), or null. Only region names and
 * UTC: not an abbreviation (EST) or a fixed offset (+08:00), which hide daylight saving and would split one zone into
 * several in the callback counts.
 */
export function canonicalZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 60 || (!tz.includes('/') && tz.toUpperCase() !== 'UTC') || /^[+-]|\d:\d|^etc\/gmt[+-]/i.test(tz)) return null;
  try { return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}
export const validTimeZone = (tz: unknown) => canonicalZone(tz) !== null;
