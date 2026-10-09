import { describe, expect, it } from 'vitest';
import { billedSeconds, lineAmount, quantityFor } from '../src/billing.js';
import { fromScaled, mulDiv, toScaled } from '../src/money.js';

const inc = (billingIncrementSeconds: number, rounding: 'up' | 'nearest' | 'down' = 'up', minimumChargeSeconds = 0) =>
  ({ billingIncrementSeconds, rounding, minimumChargeSeconds });

describe('money', () => {
  it('parses and prints exact decimals', () => {
    expect(fromScaled(toScaled('0.0140'))).toBe('0.01400000');
    expect(fromScaled(toScaled('-12.5'))).toBe('-12.50000000');
    expect(() => toScaled('1.123456789')).toThrow(/decimal places/);
    expect(() => toScaled('abc')).toThrow();
  });
  it('rounds half away from zero', () => {
    expect(mulDiv(1n, 1n, 2n)).toBe(1n);
    expect(mulDiv(-1n, 1n, 2n)).toBe(-1n);
    expect(mulDiv(1n, 1n, 3n)).toBe(0n);
  });
  it('has no floating point drift (0.1 + 0.2 style)', () => {
    expect(fromScaled(toScaled('0.1') + toScaled('0.2'))).toBe('0.30000000');
  });
});

describe('billedSeconds', () => {
  it('rounds up to the increment', () => {
    expect(billedSeconds(1, inc(6))).toBe(6);
    expect(billedSeconds(6, inc(6))).toBe(6);
    expect(billedSeconds(6.001, inc(6))).toBe(12);
    expect(billedSeconds(61, inc(60))).toBe(120);
    expect(billedSeconds(61, inc(1))).toBe(61);
  });
  it('rounds down and to nearest', () => {
    expect(billedSeconds(11, inc(6, 'down'))).toBe(6);
    expect(billedSeconds(9, inc(6, 'nearest'))).toBe(12); // exact half rounds up
    expect(billedSeconds(8, inc(6, 'nearest'))).toBe(6);
  });
  it('applies the minimum charge after rounding, but not to calls that never connected', () => {
    expect(billedSeconds(2, inc(1, 'up', 30))).toBe(30);
    expect(billedSeconds(45, inc(1, 'up', 30))).toBe(45);
    expect(billedSeconds(0, inc(6, 'up', 30))).toBe(0);
  });
  it('is exact on fractional seconds', () => {
    expect(billedSeconds(5.9996, inc(6))).toBe(6);
    expect(billedSeconds(0.0004, inc(6))).toBe(0); // rounds to zero ms: nothing to bill
  });
  it('rejects nonsense durations', () => {
    expect(() => billedSeconds(-1, inc(6))).toThrow();
    expect(() => billedSeconds(NaN, inc(6))).toThrow();
  });
});

describe('component costing', () => {
  it('prices a per-minute line on the billed (rounded) seconds', () => {
    // 61s on a 60s increment bills 120s = 2 minutes at 0.014 = 0.028
    const q = quantityFor('per_minute', 'main', {}, 120)!;
    expect(fromScaled(lineAmount('0.0140', q))).toBe('0.02800000');
  });
  it('prices a 6s block exactly', () => {
    const q = quantityFor('per_minute', 'main', {}, 6)!;
    expect(fromScaled(lineAmount('0.0140', q))).toBe('0.00140000');
  });
  it('prices characters and tokens per thousand and per million', () => {
    expect(fromScaled(lineAmount('0.30', quantityFor('per_1k_characters', 'main', { characters: 2500 }, null)!))).toBe('0.75000000');
    expect(fromScaled(lineAmount('2.50', quantityFor('per_1m_tokens', 'input', { inputTokens: 40_000, outputTokens: 9_999 }, null)!))).toBe('0.10000000');
    expect(fromScaled(lineAmount('10', quantityFor('per_1m_tokens', 'output', { inputTokens: 40_000, outputTokens: 5_000 }, null)!))).toBe('0.05000000');
    expect(fromScaled(lineAmount('2.50', quantityFor('per_1m_tokens', 'main', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, null)!))).toBe('5.00000000');
  });
  it('skips components the usage does not cover', () => {
    expect(quantityFor('per_minute', 'main', { characters: 5 }, null)).toBeNull();
    expect(quantityFor('per_character', 'main', { seconds: 10 }, 12)).toBeNull();
    expect(quantityFor('per_1m_tokens', 'main', {}, null)).toBeNull();
    expect(quantityFor('per_credit', 'main', { seconds: 10 }, 12)).toBeNull();
  });
  it('charges a flat component once', () => {
    expect(fromScaled(lineAmount('0.005', quantityFor('flat', 'main', {}, null)!))).toBe('0.00500000');
  });
});
