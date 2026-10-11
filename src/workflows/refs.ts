import { ID_RE, type Json, type WorkflowDefinition } from './definition.js';
import { slotsIn } from './render.js';

export interface Reference { node: string; kind: 'subflow' | 'handoff'; workflow: string }

/** The other workflows this one reaches, by name. */
export function referencesOf(def: WorkflowDefinition): Reference[] {
  const out: Reference[] = [];
  for (const [id, n] of Object.entries(def.nodes)) {
    if (n.type === 'subflow') out.push({ node: id, kind: 'subflow', workflow: n.workflow });
    else if (n.type === 'handoff' && 'workflow' in n.target) out.push({ node: id, kind: 'handoff', workflow: n.target.workflow });
  }
  return out;
}

/** Every variable this workflow can have set at some point: supplied, built in, captured, stored from an API, or exported. */
export function knownVariables(def: WorkflowDefinition): Set<string> {
  const known = new Set<string>(['lang', ...(def.variables ?? [])]);
  for (const [id, n] of Object.entries(def.nodes)) {
    if (n.type === 'speak' && n.listen) { known.add(n.listen.captureAs); if (n.listen.intents) known.add(`${n.listen.captureAs}_intent`); }
    if (n.type === 'api') Object.keys(n.store ?? {}).forEach((k) => known.add(k));
    if (n.type === 'subflow') { known.add(`${id}_outcome`); (n.exports ?? []).forEach((k) => known.add(k)); }
  }
  return known;
}

export interface ReferenceIssue { code: 'unknown_workflow' | 'not_deployed' | 'subflow_cycle' | 'missing_context' | 'sensitive_across_workflows'; node?: string; message: string }

const stringsIn = (v: Json | undefined, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v !== null && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
};

/** Variables a workflow marks sensitive, by list or by a sensitive answer. */
export function sensitiveOf(def: WorkflowDefinition): Set<string> {
  const out = new Set<string>(def.sensitiveVariables ?? []);
  for (const n of Object.values(def.nodes)) if (n.type === 'speak' && n.listen?.sensitive) out.add(n.listen.captureAs);
  return out;
}

/**
 * Variables a workflow reads out loud, gives to a model, sends to an integration, or records with the call's outcome (a
 * callback time). An answer's intent read for a callback time counts as the answer itself, which is forgotten with it.
 */
export function leavesTheCall(def: WorkflowDefinition): Set<string> {
  const out = new Set<string>();
  for (const n of Object.values(def.nodes)) {
    if (n.type === 'speak') {
      const texts = n.text === undefined ? [] : typeof n.text === 'string' ? [n.text] : Object.values(n.text);
      for (const t of [...texts, ...(n.speech === 'dynamic' && n.prompt ? [n.prompt] : [])]) slotsIn(t).forEach((s) => out.add(s));
    } else if (n.type === 'api') {
      for (const t of [n.path, ...stringsIn(n.body as Json | undefined)]) slotsIn(t).forEach((s) => out.add(s));
    } else if (n.type === 'end' && n.callback) {
      for (const p of [n.callback.day, n.callback.hour]) {
        if (typeof p?.var !== 'string') continue;
        out.add(p.var);
        if (p.var.endsWith('_intent')) out.add(p.var.slice(0, -'_intent'.length));
      }
    }
  }
  return out;
}

/**
 * Checks that need other workflows: does each target exist and is it live where this one is going, does the
 * caller hand over every variable the target needs, and do subflows form a loop.
 * `lookup` returns the definition live in the target environment, or 'absent' if no such workflow exists, or 'undeployed'.
 */
export function checkReferences(
  name: string, def: WorkflowDefinition,
  lookup: (workflow: string) => WorkflowDefinition | 'absent' | 'undeployed',
): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  const known = knownVariables(def);
  for (const r of referencesOf(def)) {
    const target = lookup(r.workflow);
    if (target === 'absent') { issues.push({ code: 'unknown_workflow', node: r.node, message: `"${r.node}" goes to the workflow "${r.workflow}", which does not exist.` }); continue; }
    if (target === 'undeployed') { issues.push({ code: 'not_deployed', node: r.node, message: `"${r.node}" goes to "${r.workflow}", which is not deployed there yet. Deploy it first.` }); continue; }
    // Sensitivity follows the call across workflows: what one marks sensitive, the other may not speak or send.
    const mine = sensitiveOf(def); const theirs = sensitiveOf(target);
    const theirUse = leavesTheCall(target); const myUse = leavesTheCall(def);
    const leaks = [...mine].filter((v) => theirUse.has(v));
    if (r.kind === 'subflow') leaks.push(...[...theirs].filter((v) => myUse.has(v) && !leaks.includes(v)));
    if (leaks.length) issues.push({ code: 'sensitive_across_workflows', node: r.node, message: `${leaks.map((m) => `"${m}"`).join(', ')} is sensitive in "${leaks.some((v) => mine.has(v)) ? name : r.workflow}" but spoken, sent or recorded by "${leaks.some((v) => mine.has(v)) ? r.workflow : name}". A sensitive value is never spoken, sent or recorded, in any workflow of the call.` });
    const missing = (target.variables ?? []).filter((v) => !known.has(v));
    if (missing.length) issues.push({ code: 'missing_context', node: r.node, message: `"${r.workflow}" needs ${missing.map((m) => `"${m}"`).join(', ')}, which "${name}" never has, so the call could not carry it over.` });
  }
  // Subflows nesting into each other without end cannot be allowed to run.
  const seen = new Set<string>();
  const walk = (wf: string, d: WorkflowDefinition, path: string[]): void => {
    for (const r of referencesOf(d).filter((x) => x.kind === 'subflow')) {
      if (path.includes(r.workflow)) { issues.push({ code: 'subflow_cycle', node: r.node, message: `Subflows loop: ${[...path, r.workflow].join(' → ')}.` }); continue; }
      const t = lookup(r.workflow);
      if (typeof t === 'string' || seen.has(`${wf}>${r.workflow}`)) continue;
      seen.add(`${wf}>${r.workflow}`);
      walk(r.workflow, t, [...path, r.workflow]);
    }
  };
  walk(name, def, [name]);
  return issues;
}

export const isWorkflowName = (s: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s);
export { ID_RE, slotsIn };
