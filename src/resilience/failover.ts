/**
 * Deciding when a provider has failed, and when to trust it again. Pure functions over a window of recent samples,
 * so the rules can be tested without a clock or a database.
 *
 * Hard failures are errors (API errors, dropped connections). Soft failures are dead air and sustained latency.
 * One bad sample never fails a provider over: it takes N errors in a window, or latency over a threshold for the
 * middle of a window. Running out of funding is different: it fails over at once and is never retried. And a failed
 * provider is trusted again only after a run of good samples and a minimum time, so a first sign of life does not
 * flip traffic back (hysteresis).
 */
export interface Policy {
  errorThreshold: number; errorWindowMs: number;
  latencyThresholdMs: number; latencyWindowMs: number; latencyMinSamples: number;
  deadAirMs: number;
  recoveryOkSamples: number; recoveryDwellMs: number;
}

export const DEFAULT_POLICY: Policy = {
  errorThreshold: 3, errorWindowMs: 60_000, latencyThresholdMs: 2000, latencyWindowMs: 60_000, latencyMinSamples: 5,
  deadAirMs: 4000, recoveryOkSamples: 5, recoveryDwellMs: 120_000,
};

export type SampleKind = 'ok' | 'error' | 'dead_air';
export interface Sample { at: number; kind: SampleKind; latencyMs?: number; probe?: boolean }

export type State = 'healthy' | 'failed' | 'unfunded';
export interface Health { state: State; reason?: string; okStreak: number; since: number }
export type Trigger = 'hard_errors' | 'latency' | 'dead_air' | 'funding' | 'funded_again' | 'recovered';
export interface Transition { from: State; to: State; trigger: Trigger }

export const HEALTHY: Health = { state: 'healthy', okStreak: 0, since: 0 };

/** A silence at least this long is dead air, whether or not the provider reported an error. */
export function classify(outcome: { error?: boolean; latencyMs?: number }, p: Policy): Sample['kind'] {
  if (outcome.error) return 'error';
  if (outcome.latencyMs !== undefined && outcome.latencyMs >= p.deadAirMs) return 'dead_air';
  return 'ok';
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** What, if anything, the recent samples show to be failing. Probes count: a probe is a real attempt. */
export function failing(recent: Sample[], now: number, p: Policy): Trigger | null {
  const inWindow = (w: number) => recent.filter((s) => s.at > now - w && s.at <= now);
  const errs = inWindow(p.errorWindowMs);
  if (errs.filter((s) => s.kind === 'error').length >= p.errorThreshold) return 'hard_errors';
  if (errs.filter((s) => s.kind === 'dead_air').length >= p.errorThreshold) return 'dead_air';
  const lat = inWindow(p.latencyWindowMs).filter((s) => s.latencyMs !== undefined);
  // Sustained: enough samples, and the typical one (the median) is over the threshold, so a single slow reply is not enough.
  if (lat.length >= p.latencyMinSamples && median(lat.map((s) => s.latencyMs!)) > p.latencyThresholdMs) return 'latency';
  return null;
}

/**
 * The provider's health after one more sample. `funded` is false when its balance has run out, true when it has been
 * topped up, and undefined when funding is not tracked for it (which never fails a provider).
 */
export function nextHealth(
  h: Health, recent: Sample[], now: number, p: Policy, funded: boolean | undefined,
): { health: Health; transition?: Transition } {
  const to = (state: State, trigger: Trigger, reason: string): { health: Health; transition: Transition } =>
    ({ health: { state, reason, okStreak: 0, since: now }, transition: { from: h.state, to: state, trigger } });

  if (funded === false) return h.state === 'unfunded' ? { health: h } : to('unfunded', 'funding', 'The funding balance has run out.');
  if (h.state === 'unfunded') {
    if (funded === true) return to('failed', 'funded_again', 'Funded again; on probation until it has proved itself.');
    return { health: h };
  }
  // Only samples since the last change count: what happened before the provider was last trusted is history.
  const since = recent.filter((s) => s.at >= h.since);
  if (h.state === 'healthy') {
    const trigger = failing(since, now, p);
    return trigger ? to('failed', trigger, REASONS[trigger]) : { health: h };
  }
  // failed: the run of good samples, ending at the first bad one. It must be long enough AND span the minimum time, so
  // five good replies in a row a moment apart do not count as having recovered.
  let streak = 0; let runStart = 0;
  for (const s of [...since].sort((a, b) => a.at - b.at)) {
    if (s.kind === 'ok' && (s.latencyMs === undefined || s.latencyMs <= p.latencyThresholdMs)) { if (streak === 0) runStart = s.at; streak++; } else streak = 0;
  }
  if (streak >= p.recoveryOkSamples && now - runStart >= p.recoveryDwellMs) return to('healthy', 'recovered', 'Recovered: a run of good attempts over the minimum time.');
  return { health: { ...h, okStreak: streak } };
}

const REASONS: Record<Trigger, string> = {
  hard_errors: 'Repeated errors.', latency: 'Sustained high latency.', dead_air: 'Repeated dead air.',
  funding: 'The funding balance has run out.', funded_again: 'Funded again.', recovered: 'Recovered.',
};

export interface RouteOption { providerId: string; priority: number }
/**
 * The first provider, by priority, that can take the call: healthy, and not named in `exclude` (ones already tried
 * for this call). Null means none is left, and the call goes down the fallback ladder.
 */
export function pickRoute(routes: RouteOption[], health: ReadonlyMap<string, State>, exclude: ReadonlySet<string> = new Set()): string | null {
  const ok = [...routes].sort((a, b) => a.priority - b.priority).find((r) => !exclude.has(r.providerId) && (health.get(r.providerId) ?? 'healthy') === 'healthy');
  return ok?.providerId ?? null;
}
