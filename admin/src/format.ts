/**
 * Format an exact decimal string (money, credits) for display with thousands separators,
 * dropping trailing zeros. Works on the text, so the value never passes through floating point.
 */
export function fmtDecimal(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!m) return String(value);
  const whole = (m[2] ?? '0').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const sign = m[1] && (whole !== '0' || frac) ? '-' : '';
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}
