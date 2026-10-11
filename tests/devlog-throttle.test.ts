import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module with no type declarations
import { throttleBand, throttleTable } from '../scripts/devlog-throttle.mjs';

const T = { fiveHour: { low: 70, crawl: 85, stop: 95 }, weeklyStop: 80, todayLow: 40 };
const calm = {
  usageAvailable: true, fiveHourPercent: 10, weeklyPercents: [20, 30], todayPercent: 5,
  paceAhead: false, dailyRunCapReached: false, halt: false, paused: false, accelerateEligible: false,
};
const band = (over: Record<string, unknown>) => throttleBand({ ...calm, ...over }, T);

describe('throttle bands', () => {
  it('slows to Low at 72% of the 5-hour window instead of stopping', () => {
    expect(band({ fiveHourPercent: 72 })).toEqual({ band: 'Low', reason: 'five_hour_low' });
    expect(band({ fiveHourPercent: 70 })).toEqual({ band: 'Low', reason: 'five_hour_low' });
    expect(band({ fiveHourPercent: 69 })).toEqual({ band: 'Normal', reason: 'default' });
    expect(band({ fiveHourPercent: 10, accelerateEligible: true })).toEqual({ band: 'Full', reason: 'accelerate' });
  });

  it('crawls at 85 to 94% of the 5-hour window and stops at 95%', () => {
    expect(band({ fiveHourPercent: 84 })).toEqual({ band: 'Low', reason: 'five_hour_low' });
    expect(band({ fiveHourPercent: 85 })).toEqual({ band: 'Crawl', reason: 'five_hour_crawl' });
    expect(band({ fiveHourPercent: 94 })).toEqual({ band: 'Crawl', reason: 'five_hour_crawl' });
    expect(band({ fiveHourPercent: 95 })).toEqual({ band: 'Stopped', reason: 'limit_5h' });
    expect(band({ fiveHourPercent: 100 })).toEqual({ band: 'Stopped', reason: 'limit_5h' });
  });

  it('stops when any weekly window reaches 80%, whichever window it is', () => {
    expect(band({ weeklyPercents: [79, 80] })).toEqual({ band: 'Stopped', reason: 'limit_weekly' });
    expect(band({ weeklyPercents: [80, 10] })).toEqual({ band: 'Stopped', reason: 'limit_weekly' });
    expect(band({ weeklyPercents: [10, 20, 79] })).toEqual({ band: 'Normal', reason: 'default' });
  });

  it('crawls, never stops, when the daily run cap is reached', () => {
    expect(band({ dailyRunCapReached: true })).toEqual({ band: 'Crawl', reason: 'daily_run_cap' });
  });

  it('goes to Low on pace ahead or 40% of the week used today', () => {
    expect(band({ paceAhead: true })).toEqual({ band: 'Low', reason: 'pace_ahead' });
    expect(band({ todayPercent: 39 })).toEqual({ band: 'Normal', reason: 'default' });
    expect(band({ todayPercent: 40 })).toEqual({ band: 'Low', reason: 'today_cap' });
  });

  it('stops with usage unavailable for a missing, fractional or out-of-range reading', () => {
    const stop = { band: 'Stopped', reason: 'usage_unavailable' };
    expect(band({ usageAvailable: false })).toEqual(stop);
    expect(band({ fiveHourPercent: NaN })).toEqual(stop);
    expect(band({ fiveHourPercent: undefined })).toEqual(stop);
    expect(band({ fiveHourPercent: 50.5 })).toEqual(stop);
    expect(band({ fiveHourPercent: -1 })).toEqual(stop);
    expect(band({ fiveHourPercent: 101 })).toEqual(stop);
    expect(band({ fiveHourPercent: '10' })).toEqual(stop);
    expect(band({ todayPercent: NaN })).toEqual(stop);
    expect(band({ weeklyPercents: [] })).toEqual(stop);
    expect(band({ weeklyPercents: 'none' })).toEqual(stop);
    expect(band({ weeklyPercents: [10, NaN] })).toEqual(stop);
    expect(band({ weeklyPercents: [10, 120] })).toEqual(stop);
    expect(band({ paceAhead: 'no' })).toEqual(stop);
    expect(throttleBand(null, T)).toEqual(stop);
  });

  it('stops for a halt or pause even with every reading low', () => {
    expect(band({ halt: true })).toEqual({ band: 'Stopped', reason: 'halt' });
    expect(band({ halt: true, dailyRunCapReached: true, fiveHourPercent: 90 })).toEqual({ band: 'Stopped', reason: 'halt' });
    expect(band({ paused: true, fiveHourPercent: 90 })).toEqual({ band: 'Stopped', reason: 'paused' });
    expect(band({ halt: 'false' })).toEqual({ band: 'Stopped', reason: 'halt' });
    expect(band({ paused: 0 })).toEqual({ band: 'Stopped', reason: 'paused' });
  });

  it('refuses thresholds that are not whole numbers in order', () => {
    const ok = throttleTable(T);
    expect(ok.error).toBeNull();
    expect(ok.bands.map((b: { band: string }) => b.band)).toEqual(['Full', 'Normal', 'Low', 'Crawl', 'Stopped']);
    expect(ok.bands[2].when).toBe('5-hour window 70% to 84%, or 40% of the week used today, or ahead of pace');
    expect(ok.bands[3].when).toBe('5-hour window 85% to 94%, or the daily run cap is reached');
    const bad = (t: unknown) => throttleTable(t);
    expect(bad({ ...T, fiveHour: { low: '70', crawl: 85, stop: 95 } })).toEqual({ bands: null, error: 'fiveHour.low must be a whole number' });
    expect(bad({ ...T, fiveHour: { low: 85, crawl: 85, stop: 95 } }).error).toBe('fiveHour must satisfy low < crawl < stop');
    expect(bad({ ...T, fiveHour: { low: 70, crawl: 85, stop: 101 } }).error).toBe('fiveHour.stop must be 100 or less');
    expect(bad({ ...T, fiveHour: { low: 70.5, crawl: 85, stop: 95 } }).bands).toBeNull();
    expect(bad({ ...T, weeklyStop: 0 }).error).toBe('weeklyStop must be from 1 to 100');
    expect(bad({ ...T, todayLow: 101 }).error).toBe('todayLow must be from 1 to 100');
    expect(bad(null).bands).toBeNull();
    expect(throttleBand(calm, { ...T, fiveHour: { low: 85, crawl: 85, stop: 95 } })).toEqual({ band: 'Stopped', reason: 'thresholds_invalid' });
    expect(throttleBand(calm, { ...T, weeklyStop: '80' })).toEqual({ band: 'Stopped', reason: 'thresholds_invalid' });
  });
});
