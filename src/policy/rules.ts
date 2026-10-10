/**
 * A client's policy as data: what the bot may do (action rules, each allowing or denying, perhaps up to a limit and only
 * when a condition holds) and what it may never say (phrases). Nothing here is executed: conditions use the fixed
 * language of workflow conditions. The default is to refuse: an action no rule allows is not allowed, and a rule that
 * cannot be evaluated denies.
 */
import { z } from 'zod';
import { toScaled } from '../money.js';
import { canonical } from '../workflows/versioning.js';
import { evalCondition, type Vars } from '../workflows/conditions.js';
import { ID_RE, RESERVED_NAMES, own, type Condition, type Json } from '../workflows/definition.js';
import { conditionProblems } from '../workflows/validate.js';

const name = z.string().regex(ID_RE).refine((s) => !RESERVED_NAMES.has(s), 'That name is reserved.');
const DECIMAL = /^\d{1,16}(\.\d{1,8})?$/;
const message = z.string().min(1).max(300).optional();

export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ id: name, kind: z.literal('action'), action: name, effect: z.enum(['allow', 'deny']), when: z.any().optional(), limit: z.object({ variable: name, max: z.string().regex(DECIMAL) }).strict().optional(), message }).strict(),
  z.object({ id: name, kind: z.literal('must_not_say'), phrases: z.array(z.string().min(2).max(100)).min(1).max(50), message }).strict(),
]);
export type Rule = z.infer<typeof ruleSchema>;
export const rulesSchema = z.array(ruleSchema).min(1).max(100);

/** Every reason these rules cannot be a policy, or an empty list. */
export function ruleProblems(input: unknown): string[] {
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || 'rules'}: ${i.message}`);
  const problems: string[] = []; const ids = new Set<string>();
  for (const r of parsed.data) {
    if (ids.has(r.id)) problems.push(`The rule "${r.id}" appears twice.`);
    ids.add(r.id);
    if (r.kind === 'action' && r.when !== undefined) for (const p of conditionProblems(r.when)) problems.push(`Rule "${r.id}": ${p}`);
    if (r.kind === 'action' && r.limit && r.effect === 'deny') problems.push(`Rule "${r.id}": a limit belongs on an allow rule.`);
    if (r.kind === 'must_not_say') for (const p of r.phrases) if (norm(p).trim() === '') problems.push(`Rule "${r.id}": a phrase has no words in it.`);
  }
  return problems;
}

const numeric = (v: Json | undefined): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/**
 * Three-valued: true, false, or null when the call's variables do not say (a variable missing or unreadable). The
 * workflow language treats that as false; a policy cannot, or "deny when over 1000" would let an unknown amount through.
 */
export function holds(c: Condition, vars: Vars): boolean | null {
  if ('all' in c) { let unknown = false; for (const x of c.all) { const r = holds(x, vars); if (r === false) return false; if (r === null) unknown = true; } return unknown ? null : true; }
  if ('any' in c) { let unknown = false; for (const x of c.any) { const r = holds(x, vars); if (r === true) return true; if (r === null) unknown = true; } return unknown ? null : false; }
  if ('not' in c) { const r = holds(c.not, vars); return r === null ? null : !r; }
  if (c.op === 'exists') return evalCondition(c, vars);
  const left = own(vars, c.var) ? vars[c.var] : undefined;
  const right = c.valueVar !== undefined ? (own(vars, c.valueVar) ? vars[c.valueVar] : undefined) : c.value;
  if (left === undefined || right === undefined) return null;
  if ((c.op === 'gt' || c.op === 'gte' || c.op === 'lt' || c.op === 'lte') && !(numeric(left) && numeric(right))) return null;
  return evalCondition(c, vars);
}

export interface Verdict { allowed: boolean; ruleId: string | null; reason: string }

/** May the bot do this? Deny beats allow; a limit is checked in exact decimals; anything unclear is refused. */
export function evaluate(rules: Rule[], action: string, vars: Vars): Verdict {
  try {
    // A deny whose condition cannot be judged still denies; an allow whose condition cannot be judged does not allow.
    const hits = rules.filter((r): r is Extract<Rule, { kind: 'action' }> => {
      if (r.kind !== 'action' || r.action !== action) return false;
      const h = r.when === undefined ? true : holds(r.when as Condition, vars);
      return r.effect === 'deny' ? h !== false : h === true;
    });
    const deny = hits.find((r) => r.effect === 'deny');
    if (deny) return { allowed: false, ruleId: deny.id, reason: deny.message ?? `The policy does not allow "${action}" here.` };
    const allows = hits.filter((r) => r.effect === 'allow');
    if (allows.length === 0) return { allowed: false, ruleId: null, reason: `No rule allows "${action}", so it is not allowed.` };
    for (const r of allows) {
      if (!r.limit) return { allowed: true, ruleId: r.id, reason: r.message ?? `Allowed by "${r.id}".` };
    }
    // Only limited allowances apply: one of them must be satisfied.
    let why = '';
    for (const r of allows) {
      const raw = own(vars, r.limit!.variable) ? vars[r.limit!.variable] : undefined;
      const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (!DECIMAL.test(text)) { why = `"${r.limit!.variable}" is needed to check the limit and is not a plain amount.`; continue; }
      if (toScaled(text) <= toScaled(r.limit!.max)) return { allowed: true, ruleId: r.id, reason: r.message ?? `Allowed by "${r.id}", up to ${r.limit!.max}.` };
      why = `The amount in "${r.limit!.variable}" is over the limit of ${r.limit!.max} set by "${r.id}".`;   // never the value itself: it is kept for good
    }
    return { allowed: false, ruleId: allows[0]!.id, reason: why };
  } catch {
    return { allowed: false, ruleId: null, reason: 'The policy could not be evaluated, so the action is not allowed.' };
  }
}

/** Words only: case, curly quotes, zero-width marks and punctuation do not change what is said. */
export const norm = (s: string) => ` ${s.toLowerCase().normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '').replace(/[\u2018\u2019\u02BC\u2032`]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim()} `;

/** The first banned phrase a line says, as whole words, in any case; or null. */
export function phraseViolation(rules: Rule[], line: string): { ruleId: string; phrase: string; message: string | null } | null {
  const text = norm(line);
  for (const r of rules) {
    if (r.kind !== 'must_not_say') continue;
    for (const p of r.phrases) { const n = norm(p); if (n.trim() !== '' && text.includes(n)) return { ruleId: r.id, phrase: p, message: r.message ?? null }; }
  }
  return null;
}

const shape = (r: Rule): unknown => (r.kind === 'action' ? { id: r.id, kind: r.kind, action: r.action, effect: r.effect, when: r.when ?? null, limit: r.limit ?? null } : { id: r.id, kind: r.kind, phrases: [...r.phrases].sort() });

/** Whether a change touches only the wording of messages (minor) or what the policy permits and forbids (major). */
export function classifyPolicyChange(prev: Rule[] | null, next: Rule[]): 'none' | 'minor' | 'major' {
  if (!prev) return 'major';
  if (canonical(prev) === canonical(next)) return 'none';
  const a = canonical([...prev].sort((x, y) => x.id.localeCompare(y.id)).map(shape)); const b = canonical([...next].sort((x, y) => x.id.localeCompare(y.id)).map(shape));
  return a === b ? 'minor' : 'major';
}

const describe = (r: Rule): string => r.kind === 'action'
  ? `${r.effect === 'allow' ? 'allow' : 'deny'} "${r.action}"${r.when ? ' under a condition' : ''}${r.limit ? ` up to ${r.limit.max} of ${r.limit.variable}` : ''}`
  : `never say ${r.phrases.map((p) => `“${p}”`).join(', ')}`;

/** What changed between two policies, in words. */
export function diffPolicy(prev: Rule[] | null, next: Rule[]): string[] {
  const out: string[] = []; const before = new Map((prev ?? []).map((r) => [r.id, r])); const after = new Map(next.map((r) => [r.id, r]));
  for (const [id, r] of after) {
    const old = before.get(id);
    if (!old) out.push(`Added rule "${id}": ${describe(r)}.`);
    else if (canonical(shape(old)) !== canonical(shape(r))) out.push(`Changed rule "${id}": was ${describe(old)}; now ${describe(r)}.`);
    else if (canonical(old) !== canonical(r)) out.push(`Reworded the message of rule "${id}".`);
  }
  for (const [id, r] of before) if (!after.has(id)) out.push(`Removed rule "${id}": ${describe(r)}.`);
  return out;
}
