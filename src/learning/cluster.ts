/**
 * The pure part of the learning loop: put the values of known variables back as {{slots}}, group lines that say the
 * same thing, pick one script for a group, and check a script before anyone is asked about it. No model, no database:
 * clustering uses word overlap and a threshold, and the checks are rules (per the model-tier rules).
 */
import { createHash } from 'node:crypto';
import { SLOT_RE } from '../workflows/definition.js';
import { normalizeSpoken } from '../workflows/stitch.js';
import { checkModelLine } from '../workflows/engine.js';

const WORD = /[\p{L}\p{N}']+/gu;
const words = (s: string): string[] => (s.toLowerCase().normalize('NFKC').match(WORD) ?? []);
const wordSet = (s: string): Set<string> => new Set(words(s.replace(new RegExp(SLOT_RE.source, 'g'), (_m, name: string) => ` slot_${name} `)));

/** Overlap of the words of two lines, 0 to 1. Slots count as words named for the slot, so "{{name}}" matches "{{name}}". */
export function similarity(a: string, b: string): number {
  const x = wordSet(a); const y = wordSet(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Put the values of the call's own (non-sensitive) variables back as slots, so "Hello Aisha, you owe 350" and "Hello
 * Ben, you owe 120" become the same line. Longer values go first. Only whole words are replaced. Returns the characters
 * the slots stood for, which is what stays live after promotion.
 */
export function slotify(line: string, vars: Record<string, unknown>, forbidden: readonly string[]): { text: string; slots: string[]; slotChars: number } {
  const entries = Object.entries(vars)
    .filter(([k, v]) => !forbidden.includes(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim().length >= 3)
    .map(([k, v]) => [k, String(v).trim()] as const)
    .sort((a, b) => b[1].length - a[1].length);
  let text = line; const slots: string[] = []; let slotChars = 0;
  for (const [name, value] of entries) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    text = text.replace(re, () => { if (!slots.includes(name)) slots.push(name); slotChars += [...value].length; return `{{${name}}}`; });
  }
  return { text: normalizeSpoken(text), slots, slotChars };
}

export interface Turn { text: string; count: number }
export interface Cluster { canonical: string; support: number; variants: number; members: Turn[] }

/**
 * Group lines that are alike. Each distinct wording is placed with the first group whose lead wording it matches at
 * least `threshold`; the most common wordings lead. The group's script is its medoid: the wording closest to all the
 * others, weighted by how often each was said.
 */
export function clusterTurns(turns: Turn[], threshold: number): Cluster[] {
  const merged = new Map<string, number>();
  for (const t of turns) { const k = normalizeSpoken(t.text); merged.set(k, (merged.get(k) ?? 0) + t.count); }
  const sorted = [...merged].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  const groups: Turn[][] = [];
  for (const t of sorted) {
    const home = groups.find((g) => similarity(g[0]!.text, t.text) >= threshold);
    if (home) home.push(t); else groups.push([t]);
  }
  return groups.map((members) => {
    let best = members[0]!; let bestScore = -1;
    for (const m of members) {
      const score = members.reduce((s, o) => s + o.count * similarity(m.text, o.text), 0);
      if (score > bestScore + 1e-9) { best = m; bestScore = score; }
    }
    return { canonical: best.text, support: members.reduce((s, m) => s + m.count, 0), variants: members.length, members };
  }).sort((a, b) => b.support - a.support);
}

export const slotsIn = (script: string): string[] => [...new Set([...script.matchAll(new RegExp(SLOT_RE.source, 'g'))].map((m) => m[1]!))];

export interface ScriptCheck { ok: boolean; problems: string[] }

/**
 * The checks that decide whether a script may be asked about at all, by rule: it is spoken (so it passes the same check
 * as a model's line), every slot is a variable the workflow has, none of them is sensitive, and enough of it is fixed
 * words to be worth a recording.
 */
export function checkScript(script: string, o: { variables: readonly string[]; sensitive: readonly string[] }): ScriptCheck {
  const problems: string[] = [];
  const fixed = script.split(new RegExp(SLOT_RE.source, 'g')).filter((_, i) => i % 2 === 0).map((s) => normalizeSpoken(s)).join(' ').trim();
  const asLine = checkModelLine(script.replace(new RegExp(SLOT_RE.source, 'g'), 'x'));
  if (asLine.decision === 'rejected') problems.push(asLine.reason);
  for (const s of slotsIn(script)) {
    if (!o.variables.includes(s)) problems.push(`The slot {{${s}}} is not a variable of this workflow.`);
    if (o.sensitive.includes(s)) problems.push(`The slot {{${s}}} is sensitive and can never be spoken.`);
  }
  if ([...fixed].length < 12) problems.push('Almost none of the script is fixed words, so a recording would save nothing.');
  return { ok: problems.length === 0, problems };
}

/** The characters of a script that are fixed words (recordable) and the rest (slots, spoken live). */
export function fixedChars(script: string): number {
  return script.split(new RegExp(SLOT_RE.source, 'g')).filter((_, i) => i % 2 === 0).reduce((s, p) => s + [...p.trim()].length, 0);
}

/** The part of a node a script depends on: what the model is told and the fallback text. A change to either makes a script stale. */
export const nodeHash = (node: { prompt?: string; text?: unknown } | undefined): string =>
  createHash('sha256').update(JSON.stringify({ prompt: node?.prompt ?? null, text: node?.text ?? null })).digest('hex');
