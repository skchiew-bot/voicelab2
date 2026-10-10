import { canonical, classifyChange, type Change } from '../workflows/versioning.js';
import type { Json, WorkflowDefinition, WorkflowNode } from '../workflows/definition.js';

/**
 * What changed between two versions of a workflow, in terms a person can read: nodes added or removed, wording changed,
 * and where the call now goes. The same data drives the visual diff in the console.
 */
export interface FieldChange { field: string; before: Json | null; after: Json | null }
export interface NodeChange { id: string; kind: 'added' | 'removed' | 'changed'; type: string; fields: FieldChange[] }
export interface DefinitionDiff {
  shape: Change;
  start: { before: string; after: string } | null;
  nodes: NodeChange[];
  variables: { added: string[]; removed: string[] };
  intentRoutes: { before: Json; after: Json } | null;
  /** One plain sentence per change. */
  summary: string[];
  /** Line by line, for drawing a diff: + added, - removed, ~ changed. */
  lines: { op: '+' | '-' | '~'; node: string | null; text: string }[];
}

const FIELDS_SKIPPED = new Set(['type']);
const asText = (v: Json | null | undefined): string => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const wording = (n: WorkflowNode): string => {
  const o = n as unknown as { text?: unknown; prompt?: string; outcome?: string };
  const t = typeof o.text === 'string' ? o.text : o.text && typeof o.text === 'object' ? (o.text as Record<string, string>).en : undefined;
  return t ?? o.prompt ?? o.outcome ?? '';
};
const targets = (n: WorkflowNode): string[] => ((n as unknown as { transitions?: { to: string }[] }).transitions ?? []).map((t) => t.to);

export function diffDefinitions(before: WorkflowDefinition | null, after: WorkflowDefinition): DefinitionDiff {
  const a = before?.nodes ?? {}; const b = after.nodes;
  const nodes: NodeChange[] = []; const summary: string[] = []; const lines: DefinitionDiff['lines'] = [];

  for (const id of Object.keys(b).filter((k) => !Object.hasOwn(a, k))) {
    const n = b[id]!;
    nodes.push({ id, kind: 'added', type: n.type, fields: [] });
    summary.push(`Added the ${n.type} step "${id}"${wording(n) ? `: “${wording(n)}”` : ''}.`);
    lines.push({ op: '+', node: id, text: `${n.type} ${id}${wording(n) ? ` — ${wording(n)}` : ''}` });
  }
  for (const id of Object.keys(a).filter((k) => !Object.hasOwn(b, k))) {
    const n = a[id]!;
    nodes.push({ id, kind: 'removed', type: n.type, fields: [] });
    summary.push(`Removed the ${n.type} step "${id}".`);
    lines.push({ op: '-', node: id, text: `${n.type} ${id}${wording(n) ? ` — ${wording(n)}` : ''}` });
  }
  for (const id of Object.keys(b).filter((k) => Object.hasOwn(a, k))) {
    const x = a[id]! as unknown as Record<string, Json>; const y = b[id]! as unknown as Record<string, Json>;
    const fields: FieldChange[] = [];
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (FIELDS_SKIPPED.has(f)) continue;
      if (canonical(x[f] ?? null) !== canonical(y[f] ?? null)) fields.push({ field: f, before: x[f] ?? null, after: y[f] ?? null });
    }
    if (x.type !== y.type) fields.unshift({ field: 'type', before: x.type ?? null, after: y.type ?? null });
    if (fields.length === 0) continue;
    nodes.push({ id, kind: 'changed', type: String(y.type), fields });
    for (const f of fields) {
      if (f.field === 'text' || f.field === 'prompt') {
        summary.push(`Changed the wording at "${id}": “${asText(f.before)}” is now “${asText(f.after)}”.`);
        lines.push({ op: '~', node: id, text: `wording: ${asText(f.before)} → ${asText(f.after)}` });
      } else if (f.field === 'transitions') {
        const was = targets(a[id]!).join(', ') || 'nowhere'; const now = targets(b[id]!).join(', ') || 'nowhere';
        summary.push(`"${id}" used to go to ${was}; it now goes to ${now}.`);
        lines.push({ op: '~', node: id, text: `goes to: ${was} → ${now}` });
      } else {
        summary.push(`Changed ${f.field} at "${id}".`);
        lines.push({ op: '~', node: id, text: `${f.field}: ${asText(f.before)} → ${asText(f.after)}` });
      }
    }
  }
  const start = before && before.start !== after.start ? { before: before.start, after: after.start } : null;
  if (start) { summary.unshift(`The call now starts at "${start.after}" instead of "${start.before}".`); lines.unshift({ op: '~', node: null, text: `start: ${start.before} → ${start.after}` }); }

  const va = new Set(before?.variables ?? []); const vb = new Set(after.variables ?? []);
  const variables = { added: [...vb].filter((v) => !va.has(v)), removed: [...va].filter((v) => !vb.has(v)) };
  if (variables.added.length) summary.push(`Now needs: ${variables.added.join(', ')}.`);
  if (variables.removed.length) summary.push(`No longer needs: ${variables.removed.join(', ')}.`);

  const ra = (before?.intentRoutes ?? []) as unknown as Json; const rb = (after.intentRoutes ?? []) as unknown as Json;
  const intentRoutes = canonical(ra) !== canonical(rb) ? { before: ra, after: rb } : null;
  if (intentRoutes) { summary.push('The re-routes for a change of intent were changed.'); lines.push({ op: '~', node: null, text: 'intent routes changed' }); }

  const shape = before ? classifyChange(before, after) : 'major';
  return { shape, start, nodes, variables, intentRoutes, summary, lines };
}
