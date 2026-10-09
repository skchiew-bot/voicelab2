import { fromScaled, mulDiv, toScaled } from './money.js';

export interface Comparison {
  ourSeconds: number;
  reportedSeconds?: number;
  /** Our estimated cost of this provider's lines, USD, as a decimal string. */
  ourCostUsd: string;
  /** What the provider says it charged, converted to USD. */
  reportedCostUsd?: string;
  tolerancePct: number;
}

export interface Verdict { matched: boolean; detail: string }

const MIN_SECONDS = 1n;                 // below one second of difference is clock noise
const MIN_COST = toScaled('0.0001');    // below a hundredth of a cent is rounding noise

/**
 * Does our estimate agree with the provider's own figures? Every figure the provider gave must be
 * within tolerance. With nothing to compare there is no verdict, so it refuses rather than pass.
 */
export function compare(c: Comparison): Verdict {
  if (c.reportedSeconds === undefined && c.reportedCostUsd === undefined) {
    throw new Error('Nothing to compare: the provider reported neither a duration nor a cost.');
  }
  const bp = BigInt(Math.round(c.tolerancePct * 100)); // basis points
  const notes: string[] = [];
  let matched = true;

  if (c.reportedSeconds !== undefined) {
    const ours = BigInt(Math.round(c.ourSeconds * 1000)); const theirs = BigInt(Math.round(c.reportedSeconds * 1000));
    const diff = ours > theirs ? ours - theirs : theirs - ours;
    const allowed = [MIN_SECONDS * 1000n, mulDiv(ours, bp, 10_000n)].reduce((a, b) => (a > b ? a : b));
    const ok = diff <= allowed;
    matched &&= ok;
    notes.push(`duration ${ok ? 'agrees' : 'differs'}: ours ${c.ourSeconds}s, provider ${c.reportedSeconds}s`);
  }
  if (c.reportedCostUsd !== undefined) {
    const ours = toScaled(c.ourCostUsd); const theirs = toScaled(c.reportedCostUsd);
    const diff = ours > theirs ? ours - theirs : theirs - ours;
    const allowed = [MIN_COST, mulDiv(ours, bp, 10_000n)].reduce((a, b) => (a > b ? a : b));
    const ok = diff <= allowed;
    matched &&= ok;
    notes.push(`cost ${ok ? 'agrees' : 'differs'}: ours ${c.ourCostUsd} USD, provider ${c.reportedCostUsd} USD (difference ${fromScaled(diff)})`);
  }
  return { matched, detail: notes.join('; ') };
}
