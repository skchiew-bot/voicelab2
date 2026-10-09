import { mulDiv, toScaled } from './money.js';

export type Rounding = 'up' | 'nearest' | 'down';

export interface Increment {
  billingIncrementSeconds: number;
  minimumChargeSeconds: number;
  rounding: Rounding;
}

/**
 * Seconds a provider bills for a call of the given length: round to the billing
 * increment, then apply the minimum charge. A call that never connected (zero
 * seconds) is not billed, so the minimum does not apply to it. The client credit
 * meter calls this with the same provider increment, so short calls cannot leak
 * margin through rounding.
 */
export function billedSeconds(actualSeconds: number, inc: Increment): number {
  if (!Number.isFinite(actualSeconds) || actualSeconds < 0) throw new Error('Duration must be zero or more seconds.');
  const ms = BigInt(Math.round(actualSeconds * 1000));
  if (ms === 0n) return 0;
  const incMs = BigInt(inc.billingIncrementSeconds) * 1000n;
  const blocks =
    inc.rounding === 'up' ? (ms + incMs - 1n) / incMs
    : inc.rounding === 'down' ? ms / incMs
    : (2n * ms + incMs) / (2n * incMs); // nearest, halves round up
  const seconds = Number((blocks * incMs) / 1000n);
  return Math.max(seconds, inc.minimumChargeSeconds);
}

export type Unit = 'per_minute' | 'per_second' | 'per_character' | 'per_1k_characters' | 'per_token'
  | 'per_1k_tokens' | 'per_1m_tokens' | 'per_credit' | 'flat';

export interface Usage {
  /** Actual call seconds, before the provider's rounding. */
  seconds?: number;
  /** Synthesised characters only: pre-recorded audio costs nothing to synthesise and is not counted. */
  characters?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Concurrency or burst surcharge was triggered for this usage. */
  burst?: boolean;
}

export interface LineQuantity { quantity: string; billedSeconds: number | null }

/**
 * How much of a component's unit this usage represents, as an exact fraction
 * (num/den), or null when the usage does not cover this component.
 * For token components, billing_line "input" or "output" picks that direction;
 * anything else bills input plus output.
 */
export function quantityFor(
  unit: Unit, billingLine: string, usage: Usage, billed: number | null,
): { num: bigint; den: bigint; display: string; billedSeconds: number | null } | null {
  const whole = (n: number | undefined, den: bigint, display?: string) =>
    n === undefined ? null : { num: BigInt(Math.round(n)), den, display: display ?? String(n), billedSeconds: null };
  switch (unit) {
    case 'per_minute':
      return billed === null ? null : { num: BigInt(billed), den: 60n, display: `${billed}s`, billedSeconds: billed };
    case 'per_second':
      return billed === null ? null : { num: BigInt(billed), den: 1n, display: `${billed}s`, billedSeconds: billed };
    case 'per_character': return whole(usage.characters, 1n);
    case 'per_1k_characters': return whole(usage.characters, 1000n);
    case 'per_token':
    case 'per_1k_tokens':
    case 'per_1m_tokens': {
      const tokens = billingLine === 'input' ? usage.inputTokens
        : billingLine === 'output' ? usage.outputTokens
        : usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined
        : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      return whole(tokens, unit === 'per_token' ? 1n : unit === 'per_1k_tokens' ? 1000n : 1_000_000n);
    }
    case 'per_credit': return null; // priced by the credit meter, not by usage
    case 'flat': return { num: 1n, den: 1n, display: '1', billedSeconds: null };
  }
}

/** Cost of one component line, scaled by 1e-8, before any burst premium. */
export function lineAmount(rate: string, q: { num: bigint; den: bigint }): bigint {
  return mulDiv(toScaled(rate), q.num, q.den);
}
