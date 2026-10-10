import { describe, expect, it } from 'vitest';
import {
  addDays, balanceAfter, bestTimesToCall, channelFor, inQuietHours, localParts, localToInstant, nextAllowed, nextTreatment, plainAmount, readBack, retryDelayMinutes, waitForLimits,
} from '../src/cases/policy.js';

const KL = 'Asia/Kuala_Lumpur';           // UTC+8, no daylight saving
const at = (iso: string) => new Date(iso);

describe('quiet hours', () => {
  it('uses the contact\'s own clock, and the window wraps midnight', () => {
    // 14:00 UTC is 22:00 in Kuala Lumpur and 07:00 in Los Angeles (UTC-7 in October)
    expect(inQuietHours(at('2026-10-10T14:00:00Z'), KL, '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at('2026-10-10T14:00:00Z'), 'America/Los_Angeles', '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at('2026-10-10T02:00:00Z'), KL, '21:00', '08:00')).toBe(false);       // 10:00 local
    expect(inQuietHours(at('2026-10-10T00:00:00Z'), KL, '21:00', '08:00')).toBe(false);       // 08:00 local: the end is not quiet
    expect(inQuietHours(at('2026-10-10T13:00:00Z'), KL, '21:00', '08:00')).toBe(true);        // 21:00 local: the start is quiet
    expect(inQuietHours(at('2026-10-10T04:00:00Z'), KL, '12:00', '14:00')).toBe(true);        // a window inside one day: 12:00 local
    expect(inQuietHours(at('2026-10-10T04:00:00Z'), KL, '08:00', '08:00')).toBe(false);       // an empty window
  });
  it('finds the first moment a call may be made', () => {
    expect(nextAllowed(at('2026-10-10T14:30:00Z'), KL, '21:00', '08:00').toISOString()).toBe('2026-10-11T00:00:00.000Z');   // 08:00 local next day
    expect(nextAllowed(at('2026-10-10T02:00:00Z'), KL, '21:00', '08:00').toISOString()).toBe('2026-10-10T02:00:00.000Z');   // already allowed
  });
  it('turns a local date and time into the instant, and reads a zone\'s date and weekday', () => {
    expect(localToInstant('2026-10-12', '09:00', KL).toISOString()).toBe('2026-10-12T01:00:00.000Z');
    expect(localToInstant('2026-10-12', '09:00', 'America/Los_Angeles').toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(localParts(at('2026-10-10T20:00:00Z'), KL)).toEqual({ date: '2026-10-11', hour: 4, minute: 0, dow: 0 });          // already Sunday in KL
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('how often a contact may be called', () => {
  const limits = { maxPerDay: 3, maxPerWeek: 10, minGapMinutes: 60 };
  const now = at('2026-10-10T06:00:00Z');
  it('waits for the minimum gap first, then the daily and weekly limits', () => {
    expect(waitForLimits(now, { dayCount: 0, weekCount: 0, lastAt: null }, limits)).toBeNull();
    expect(waitForLimits(now, { dayCount: 1, weekCount: 1, lastAt: at('2026-10-10T05:30:00Z') }, limits)).toMatchObject({ reason: 'minimum_gap', until: at('2026-10-10T06:30:00Z') });
    expect(waitForLimits(now, { dayCount: 1, weekCount: 1, lastAt: at('2026-10-10T04:00:00Z') }, limits)).toBeNull();
    expect(waitForLimits(now, { dayCount: 3, weekCount: 3, lastAt: at('2026-10-10T01:00:00Z') }, limits)?.reason).toBe('daily_limit');
    expect(waitForLimits(now, { dayCount: 2, weekCount: 10, lastAt: at('2026-10-10T01:00:00Z') }, limits)?.reason).toBe('weekly_limit');
  });
});

describe('retries, channels and treatment', () => {
  it('backs off by the list and repeats its last step', () => {
    expect([1, 2, 3, 4, 9].map((n) => retryDelayMinutes([60, 240, 1440], n))).toEqual([60, 240, 1440, 1440, 1440]);
  });
  it('moves to the next channel after enough failures, and stays on the last', () => {
    const ch = ['voice', 'whatsapp', 'sms'];
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => channelFor(ch, n, 2))).toEqual(['voice', 'voice', 'whatsapp', 'whatsapp', 'sms', 'sms', 'sms']);
  });
  it('makes treatment firmer one step at a time, up to the last', () => {
    expect([0, 1, 2, 3].map((n) => nextTreatment(n, 3))).toEqual([1, 2, 2, 2]);
  });
});

describe('when the contact is easiest to reach', () => {
  it('ranks day-and-hour slots by a smoothed answer rate and ignores calls that never reached the phone', () => {
    const a = (dow: number, hour: number, outcome: 'answered' | 'no_answer' | 'failed') => ({ dow, hour, outcome });
    const best = bestTimesToCall([
      a(1, 10, 'answered'), a(1, 10, 'answered'), a(1, 10, 'answered'), a(1, 10, 'no_answer'),   // 3 of 4
      a(2, 19, 'answered'),                                                                       // 1 of 1 — luck, not a pattern
      a(3, 8, 'no_answer'), a(3, 8, 'no_answer'),
      a(4, 12, 'failed'),
    ]);
    expect(best.map((s) => [s.dow, s.hour])).toEqual([[1, 10], [2, 19], [3, 8]]);
    expect(best[0]).toMatchObject({ answered: 3, tried: 4, score: 0.667 });
    expect(best.some((s) => s.dow === 4)).toBe(false);
  });
});

describe('money and the read-back', () => {
  it('recalculates the balance exactly, never below zero', () => {
    expect(balanceAfter('350.00000000', '100.10000000')).toBe('249.90000000');
    expect(balanceAfter('0.30000000', '0.10000000')).toBe('0.20000000');            // no 0.19999999999999998
    expect(balanceAfter('100.00000000', '150.00000000')).toBe('0.00000000');
  });
  it('trims an amount for speech', () => {
    expect(['350.00000000', '12.50000000', '0.05000000', '1200.25000000'].map(plainAmount)).toEqual(['350', '12.50', '0.05', '1200.25']);
  });
  it('reads back what was arranged, from the case\'s own records', () => {
    expect(readBack({ currency: 'MYR', balance: '250.00000000', promise: { amount: '100.00000000', dueOn: '2026-10-15' }, callback: { at: '2026-10-12T01:00:00Z', timeZone: KL } }))
      .toBe('You have agreed to pay 100 MYR by 2026-10-15. We will call you back on 2026-10-12 at 09:00. The balance now is 250 MYR.');
    expect(readBack({ currency: 'MYR', balance: '0.00000000' })).toBe('The balance now is 0 MYR.');
  });
});
