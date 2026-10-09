import type { Condition, Json } from './definition.js';

export type Vars = Record<string, Json>;

const same = (a: Json | undefined, b: Json | undefined): boolean =>
  a !== undefined && b !== undefined && (typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b));

function num(v: Json | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Evaluate a condition against the call's variables. A variable that is not set makes a comparison false, never an error. */
export function evalCondition(c: Condition, vars: Vars): boolean {
  if ('all' in c) return c.all.every((x) => evalCondition(x, vars));
  if ('any' in c) return c.any.some((x) => evalCondition(x, vars));
  if ('not' in c) return !evalCondition(c.not, vars);
  const left = vars[c.var];
  if (c.op === 'exists') return left !== undefined && left !== null && left !== '';
  const right = c.valueVar !== undefined ? vars[c.valueVar] : c.value;
  switch (c.op) {
    case 'eq': return same(left, right);
    case 'ne': return left !== undefined && right !== undefined && !same(left, right);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = num(left); const b = num(right);
      if (a === null || b === null) return false;
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
    case 'contains':
      if (Array.isArray(left)) return right !== undefined && left.some((x) => same(x, right));
      return typeof left === 'string' && right !== undefined && right !== null && left.toLowerCase().includes(String(right).toLowerCase());
    case 'in': return Array.isArray(right) && left !== undefined && right.some((x) => same(x, left));
    default: return false;
  }
}

/** Variables a condition reads, for the validator. */
export function conditionVars(c: Condition, out = new Set<string>()): Set<string> {
  if ('all' in c) c.all.forEach((x) => conditionVars(x, out));
  else if ('any' in c) c.any.forEach((x) => conditionVars(x, out));
  else if ('not' in c) conditionVars(c.not, out);
  else { out.add(c.var); if (c.valueVar !== undefined) out.add(c.valueVar); }
  return out;
}
