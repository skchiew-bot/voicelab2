import { createHash } from 'node:crypto';
import type { Vars } from './conditions.js';
import { SLOT_RE } from './definition.js';
import { renderText } from './render.js';

/**
 * Stitching: play Voice Lab's own pre-recorded audio where the words are fixed, and synthesise only what cannot be
 * recorded (a name, an amount). Recorded audio costs nothing to synthesise, so the cost of a line is the characters
 * that are still spoken live. Nothing here touches audio: it decides which parts are which, and counts them.
 */
export interface RecordingRef { id: string; durationMs: number }
export interface RecordingIndex { find(language: string, text: string): RecordingRef | undefined }

export type Segment =
  | { kind: 'recorded'; characters: number; recordingId: string; durationMs: number }
  | { kind: 'synth'; characters: number };

export interface SpeechPlan {
  segments: Segment[];
  /** Characters spoken by a synthesiser: what the voice provider bills. */
  synthCharacters: number;
  /** Characters played from a recording: no synthesis cost. */
  recordedCharacters: number;
  /** Where a recording meets live speech (or another recording). These are the places a listener could hear a join. */
  seams: number;
}

/** Recordings are found by the words, so what is played is always what the workflow says. */
export const normalizeSpoken = (text: string): string => text.trim().replace(/\s+/g, ' ');
export const textHash = (language: string, text: string): string =>
  createHash('sha256').update(`${language}\n${normalizeSpoken(text)}`).digest('hex');

const count = (s: string) => [...s.trim()].length;

interface Piece { text: string; live: boolean }

/** The whole line as one piece of live speech. */
export function synthOnly(line: string): SpeechPlan {
  const n = count(line);
  return { segments: n > 0 ? [{ kind: 'synth', characters: n }] : [], synthCharacters: n, recordedCharacters: 0, seams: 0 };
}

/**
 * Plan a fixed or hybrid line. The fixed words of a frame use a recording where one exists for exactly those words;
 * slot values are always live. Neighbouring live parts are joined into one request, so the voice reads them as one
 * phrase instead of in pieces.
 */
export function planSpeech(
  template: string, vars: Vars, forbidden: readonly string[], language: string, index: RecordingIndex | undefined,
): SpeechPlan {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of template.matchAll(new RegExp(SLOT_RE.source, 'g'))) {
    if (m.index! > last) pieces.push({ text: template.slice(last, m.index), live: false });
    pieces.push({ text: renderText(m[0], vars, forbidden), live: true });
    last = m.index! + m[0].length;
  }
  if (last < template.length) pieces.push({ text: template.slice(last), live: false });

  const segments: Segment[] = [];
  let live = '';
  const flush = () => { if (count(live) > 0) segments.push({ kind: 'synth', characters: count(live) }); live = ''; };
  for (const p of pieces) {
    const ref = !p.live && index && normalizeSpoken(p.text) !== '' ? index.find(language, p.text) : undefined;
    if (ref) { flush(); segments.push({ kind: 'recorded', characters: count(p.text), recordingId: ref.id, durationMs: ref.durationMs }); }
    else live += p.text;
  }
  flush();
  return {
    segments,
    synthCharacters: segments.reduce((s, x) => s + (x.kind === 'synth' ? x.characters : 0), 0),
    recordedCharacters: segments.reduce((s, x) => s + (x.kind === 'recorded' ? x.characters : 0), 0),
    seams: Math.max(0, segments.length - 1),
  };
}

export interface Frame { node: string; language: string; text: string; characters: number }

/** The fixed words of a workflow, by language: what could be pre-recorded. Slots and model-written lines are never in it. */
export function framesOf(def: { nodes: Record<string, { type: string; speech?: string; text?: unknown }> }): Frame[] {
  const out: Frame[] = [];
  for (const [node, n] of Object.entries(def.nodes)) {
    if (n.type !== 'speak' || (n.speech !== 'fixed' && n.speech !== 'hybrid') || n.text === undefined) continue;
    const byLanguage: [string, string][] = typeof n.text === 'string' ? [['en', n.text]]
      : n.text !== null && typeof n.text === 'object' ? Object.entries(n.text as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
    for (const [language, template] of byLanguage) {
      for (const lit of template.split(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/)) {
        if (normalizeSpoken(lit) !== '') out.push({ node, language, text: normalizeSpoken(lit), characters: count(lit) });
      }
    }
  }
  return out;
}
