// Throttle bands for the always-on runner (blueprint ADR-0014 section 2). Pure functions, no I/O. One definition: the
// table shown on the page and the band calculation both come from the same validated thresholds (lesson L-033).
// A reading that cannot be judged is a stop, never a pass (lesson L-032).

const isWhole = (n) => typeof n === 'number' && Number.isInteger(n);
const isPercent = (n) => isWhole(n) && n >= 0 && n <= 100;

/**
 * Check the thresholds. Returns a message saying what is wrong, or null when they are usable.
 * @param {any} t {fiveHour: {low, crawl, stop}, weeklyStop, todayLow}
 * @returns {string | null}
 */
function thresholdError(t) {
  if (!t || typeof t !== 'object' || !t.fiveHour || typeof t.fiveHour !== 'object') return 'thresholds are missing';
  const { low, crawl, stop } = t.fiveHour;
  for (const [name, v] of [['fiveHour.low', low], ['fiveHour.crawl', crawl], ['fiveHour.stop', stop], ['weeklyStop', t.weeklyStop], ['todayLow', t.todayLow]]) {
    if (!isWhole(v)) return `${name} must be a whole number`;
  }
  if (!(low < crawl && crawl < stop)) return 'fiveHour must satisfy low < crawl < stop';
  if (stop > 100) return 'fiveHour.stop must be 100 or less';
  if (low < 0) return 'fiveHour.low must not be negative';
  if (t.weeklyStop < 1 || t.weeklyStop > 100) return 'weeklyStop must be from 1 to 100';
  if (t.todayLow < 1 || t.todayLow > 100) return 'todayLow must be from 1 to 100';
  return null;
}

/**
 * The band table the page shows, built from the thresholds. Null bands and a message when the thresholds are not valid.
 * @param {any} t thresholds, validated here
 * @returns {{bands: {band: string, when: string}[] | null, error: string | null}}
 */
export function throttleTable(t) {
  const error = thresholdError(t);
  if (error) return { bands: null, error };
  const { low, crawl, stop } = t.fiveHour;
  return {
    error: null,
    bands: [
      { band: 'Full', when: 'Every condition for accelerating is met' },
      { band: 'Normal', when: 'Otherwise' },
      { band: 'Low', when: `5-hour window ${low}% to ${crawl - 1}%, or ${t.todayLow}% of the week used today, or ahead of pace` },
      { band: 'Crawl', when: `5-hour window ${crawl}% to ${stop - 1}%, or the daily run cap is reached` },
      { band: 'Stopped', when: `5-hour window ${stop}% or more, or any weekly window ${t.weeklyStop}% or more, or usage unavailable, or a halt, or paused` },
    ],
  };
}

/**
 * Decide the throttle band from one reading. Stopped wins over Crawl, Crawl over Low, Low over Full.
 * @param {any} r {usageAvailable, fiveHourPercent, weeklyPercents[], todayPercent, paceAhead, dailyRunCapReached, halt, paused, accelerateEligible}
 * @param {any} t {fiveHour: {low, crawl, stop}, weeklyStop, todayLow}
 * @returns {{band: 'Full' | 'Normal' | 'Low' | 'Crawl' | 'Stopped', reason: string}}
 */
export function throttleBand(r, t) {
  const stopped = (reason) => ({ band: 'Stopped', reason });
  if (thresholdError(t)) return stopped('thresholds_invalid');
  if (!r || typeof r !== 'object' || r.usageAvailable !== true) return stopped('usage_unavailable');
  if (typeof r.halt !== 'boolean' || r.halt) return stopped('halt');
  if (typeof r.paused !== 'boolean' || r.paused) return stopped('paused');
  if (!isPercent(r.fiveHourPercent) || !isPercent(r.todayPercent)
    || !Array.isArray(r.weeklyPercents) || r.weeklyPercents.length === 0 || !r.weeklyPercents.every(isPercent)
    || typeof r.paceAhead !== 'boolean' || typeof r.dailyRunCapReached !== 'boolean' || typeof r.accelerateEligible !== 'boolean') {
    return stopped('usage_unavailable');
  }
  if (r.fiveHourPercent >= t.fiveHour.stop) return stopped('limit_5h');
  if (r.weeklyPercents.some((p) => p >= t.weeklyStop)) return stopped('limit_weekly');
  if (r.fiveHourPercent >= t.fiveHour.crawl) return { band: 'Crawl', reason: 'five_hour_crawl' };
  if (r.dailyRunCapReached) return { band: 'Crawl', reason: 'daily_run_cap' };
  if (r.paceAhead) return { band: 'Low', reason: 'pace_ahead' };
  if (r.todayPercent >= t.todayLow) return { band: 'Low', reason: 'today_cap' };
  if (r.fiveHourPercent >= t.fiveHour.low) return { band: 'Low', reason: 'five_hour_low' };
  if (r.accelerateEligible) return { band: 'Full', reason: 'accelerate' };
  return { band: 'Normal', reason: 'default' };
}
