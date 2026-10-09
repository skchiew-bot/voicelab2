import { describe, expect, it } from 'vitest';
import { DEFAULT_FALLBACK, fallbackLadder } from '../src/resilience/fallback.js';
import { classify, DEFAULT_POLICY as P, failing, HEALTHY, nextHealth, pickRoute, type Health, type Sample } from '../src/resilience/failover.js';

const S = 1000;
const err = (at: number): Sample => ({ at, kind: 'error' });
const ok = (at: number, latencyMs = 200): Sample => ({ at, kind: 'ok', latencyMs });
const slow = (at: number, latencyMs = 3000): Sample => ({ at, kind: 'ok', latencyMs });

describe('what counts as failing', () => {
  it('needs N errors inside the window: one error, or errors spread too far apart, are not enough', () => {
    expect(failing([err(100 * S)], 100 * S, P)).toBeNull();
    expect(failing([err(100 * S), err(101 * S)], 101 * S, P)).toBeNull();
    expect(failing([err(100 * S), err(101 * S), err(102 * S)], 102 * S, P)).toBe('hard_errors');
    expect(failing([err(10 * S), err(50 * S), err(100 * S)], 100 * S, P)).toBeNull(); // the first is more than 60 s old
  });
  it('treats dead air as a soft failure, counted the same way', () => {
    const d = (at: number): Sample => ({ at, kind: 'dead_air', latencyMs: 5000 });
    expect(failing([d(1 * S), d(2 * S)], 2 * S, P)).toBeNull();
    expect(failing([d(1 * S), d(2 * S), d(3 * S)], 3 * S, P)).toBe('dead_air');
  });
  it('needs latency to be sustained: a single slow reply, or too few samples, or a slow outlier among fast ones, does not count', () => {
    expect(failing([slow(1 * S, 9000)], 1 * S, P)).toBeNull();
    expect(failing([slow(1 * S), slow(2 * S), slow(3 * S), slow(4 * S)], 4 * S, P)).toBeNull();               // 4 samples: under the minimum of 5
    expect(failing([ok(1 * S), ok(2 * S), ok(3 * S), ok(4 * S), slow(5 * S, 30000)], 5 * S, P)).toBeNull();   // one outlier
    expect(failing([slow(1 * S), slow(2 * S), slow(3 * S), ok(4 * S), ok(5 * S)], 5 * S, P)).toBe('latency'); // median is slow
  });
  it('classifies a long silence as dead air even when the provider reported no error', () => {
    expect(classify({ latencyMs: 4000 }, P)).toBe('dead_air');
    expect(classify({ latencyMs: 3999 }, P)).toBe('ok');
    expect(classify({ error: true, latencyMs: 10 }, P)).toBe('error');
  });
});

describe('health: failing over, and trusting again only slowly', () => {
  const fail = (): { h: Health; at: number } => {
    const recent = [err(100 * S), err(101 * S), err(102 * S)];
    const r = nextHealth({ ...HEALTHY, since: 0 }, recent, 102 * S, P, undefined);
    expect(r.transition).toEqual({ from: 'healthy', to: 'failed', trigger: 'hard_errors' });
    return { h: r.health, at: 102 * S };
  };

  it('stays healthy through isolated errors', () => {
    const r = nextHealth({ ...HEALTHY }, [err(100 * S), err(101 * S)], 101 * S, P, undefined);
    expect(r.health.state).toBe('healthy'); expect(r.transition).toBeUndefined();
  });
  it('does not switch back on the first sign of recovery, nor on a run of good samples that comes too soon', () => {
    const { h, at } = fail();
    const good = (n: number, from: number) => Array.from({ length: n }, (_, i) => ok(from + i * S));
    expect(nextHealth(h, [...good(1, at + S)], at + S, P, undefined).health.state).toBe('failed');
    const five = good(5, at + S);
    expect(nextHealth(h, five, at + 6 * S, P, undefined).health.state).toBe('failed');       // five good, but a moment apart
    // five good a moment apart do not count however long ago the provider failed: the run itself must span the minimum time
    expect(nextHealth(h, good(5, at + 500 * S), at + 505 * S, P, undefined).health.state).toBe('failed');
    const spaced = Array.from({ length: 5 }, (_, i) => ok(at + 500 * S + i * 30 * S));         // 0, 30, 60, 90, 120 s
    expect(nextHealth(h, spaced, at + 620 * S, P, undefined).transition).toEqual({ from: 'failed', to: 'healthy', trigger: 'recovered' });
  });
  it('restarts the run of good samples at any bad one, and does not count a slow success as good', () => {
    const { h, at } = fail();
    const t = at + 200 * S;
    const mixed = [ok(t), ok(t + S), ok(t + 2 * S), err(t + 3 * S), ok(t + 4 * S), ok(t + 5 * S), ok(t + 6 * S), ok(t + 7 * S)];
    expect(nextHealth(h, mixed, t + 8 * S, P, undefined).health).toMatchObject({ state: 'failed', okStreak: 4 });
    const withSlow = [ok(t), ok(t + S), slow(t + 2 * S), ok(t + 3 * S), ok(t + 4 * S), ok(t + 5 * S)];
    expect(nextHealth(h, withSlow, t + 6 * S, P, undefined).health).toMatchObject({ state: 'failed', okStreak: 3 });
  });
  it('is not failed again at once by the errors that failed it before: only what happened since counts', () => {
    const { h, at } = fail();
    const t = at + 200 * S;
    const goods = Array.from({ length: 5 }, (_, i) => ok(t + i * 30 * S));
    const back = nextHealth(h, [...[100, 101, 102].map((s) => err(s * S)), ...goods], t + 125 * S, P, undefined);
    expect(back.health.state).toBe('healthy');
    const again = nextHealth(back.health, [err(100 * S), err(101 * S), err(102 * S), ...goods], t + 126 * S, P, undefined);
    expect(again.health.state).toBe('healthy');
  });
  it('is not failed again by the errors that failed it, even when the dwell is shorter than the error window', () => {
    const q = { ...P, recoveryDwellMs: 10 * S };
    const failed = nextHealth({ ...HEALTHY }, [err(100 * S), err(101 * S), err(102 * S)], 102 * S, q, undefined).health;
    const goods = Array.from({ length: 5 }, (_, i) => ok(103 * S + i * 3 * S));      // 103..115 s: spans the 10 s minimum
    const back = nextHealth(failed, [err(100 * S), err(101 * S), err(102 * S), ...goods], 116 * S, q, undefined);
    expect(back.health.state).toBe('healthy');
    // the three old errors are still inside the 60 s window, but they belong to before it was trusted again
    expect(nextHealth(back.health, [err(100 * S), err(101 * S), err(102 * S), ...goods], 117 * S, q, undefined).health.state).toBe('healthy');
  });
  it('fails over at once when funding runs out, whatever the samples say, and stays failed over until topped up', () => {
    const r = nextHealth({ ...HEALTHY }, [ok(1 * S)], 1 * S, P, false);
    expect(r.transition).toEqual({ from: 'healthy', to: 'unfunded', trigger: 'funding' });
    // still unfunded: no transition, no matter how many good samples arrive
    expect(nextHealth(r.health, Array.from({ length: 20 }, (_, i) => ok(i * S)), 500 * S, P, false)).toEqual({ health: r.health });
    expect(nextHealth(r.health, Array.from({ length: 20 }, (_, i) => ok(i * S)), 500 * S, P, undefined).health.state).toBe('unfunded');
  });
  it('puts a topped-up provider on probation instead of trusting it immediately', () => {
    const unfunded = nextHealth({ ...HEALTHY }, [], 10 * S, P, false).health;
    const topped = nextHealth(unfunded, [], 20 * S, P, true);
    expect(topped.transition).toEqual({ from: 'unfunded', to: 'failed', trigger: 'funded_again' });
    expect(topped.health.state).toBe('failed');
  });
  it('does not fail a provider whose funding is not tracked', () => {
    expect(nextHealth({ ...HEALTHY }, [], 1 * S, P, undefined).health.state).toBe('healthy');
  });
});

describe('choosing where a call goes', () => {
  const routes = [{ providerId: 'b', priority: 2 }, { providerId: 'a', priority: 1 }, { providerId: 'c', priority: 3 }];
  it('takes the first healthy provider by priority', () => {
    expect(pickRoute(routes, new Map())).toBe('a');
    expect(pickRoute(routes, new Map([['a', 'failed']]))).toBe('b');
    expect(pickRoute(routes, new Map([['a', 'unfunded'], ['b', 'failed']]))).toBe('c');
  });
  it('skips ones already tried for this call, and returns null when nothing is left', () => {
    expect(pickRoute(routes, new Map(), new Set(['a']))).toBe('b');
    expect(pickRoute(routes, new Map([['a', 'failed'], ['b', 'failed'], ['c', 'unfunded']]))).toBeNull();
    expect(pickRoute([], new Map())).toBeNull();
  });
});

describe('the fallback ladder: a call is never dropped dead', () => {
  const plan = { ...DEFAULT_FALLBACK, holdingMessage: 'One moment.' };
  it('always starts with the holding message and always ends in a person or a recorded callback request', () => {
    for (const offerCallback of [true, false]) for (const humanTransfer of [true, false]) for (const voicemail of [true, false]) for (const humanAvailable of [true, false]) {
      const steps = fallbackLadder({ ...plan, offerCallback, humanTransfer, voicemail }, { humanAvailable });
      expect(steps[0]).toEqual({ kind: 'holding_message', text: 'One moment.' });
      expect(['transfer_human', 'record_callback_request']).toContain(steps[steps.length - 1]!.kind);
    }
  });
  it('prefers a person who is there, then a callback offer, then voicemail', () => {
    const kinds = (p: Partial<typeof plan>, humanAvailable: boolean) => fallbackLadder({ ...plan, ...p }, { humanAvailable }).map((s) => s.kind);
    expect(kinds({ humanTransfer: true }, true)).toEqual(['holding_message', 'transfer_human']);
    expect(kinds({ humanTransfer: true }, false)).toEqual(['holding_message', 'offer_callback', 'record_callback_request']);
    expect(kinds({ offerCallback: false, voicemail: true }, false)).toEqual(['holding_message', 'voicemail', 'record_callback_request']);
    expect(kinds({ offerCallback: false, voicemail: false }, false)).toEqual(['holding_message', 'record_callback_request']);
  });
});
