/**
 * Exact decimal arithmetic for money. Amounts are BigInt counts of 1e-8, so
 * nothing passes through floating point. Postgres numeric(18,8) matches the scale.
 */
export const SCALE = 100_000_000n;

export function toScaled(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a decimal number: "${value}"`);
  const frac = (m[3] ?? '').padEnd(8, '0');
  if (frac.length > 8 && /[1-9]/.test(frac.slice(8))) throw new Error(`Too many decimal places: "${value}"`);
  const n = BigInt(m[2]!) * SCALE + BigInt(frac.slice(0, 8));
  return m[1] === '-' ? -n : n;
}

export function fromScaled(n: bigint): string {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(8, '0')}`;
}

/** a * num / den, rounded half away from zero. */
export function mulDiv(a: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('Division by zero');
  const sign = (a < 0n) !== (num < 0n) !== (den < 0n) ? -1n : 1n;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const n = abs(a) * abs(num);
  const d = abs(den);
  return sign * ((2n * n + d) / (2n * d));
}
