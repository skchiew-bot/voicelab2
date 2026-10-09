import { SLOT_RE, type LocalText } from './definition.js';
import type { Vars } from './conditions.js';

export class MissingVariable extends Error {
  constructor(public variable: string) { super(`The variable "${variable}" is not set.`); }
}

/** The language to speak: the caller's, if the text has it, otherwise English. */
export function pickText(text: LocalText, lang: string | undefined): string | undefined {
  if (typeof text === 'string') return text;
  return (lang !== undefined ? text[lang] : undefined) ?? text.en;
}

/**
 * Fill {{slots}} from variables. A missing variable throws instead of speaking a gap or a placeholder
 * to a caller: the call is better ended and flagged than made to say something wrong.
 */
export function renderText(template: string, vars: Vars): string {
  return template.replace(SLOT_RE, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') throw new MissingVariable(name);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function slotsIn(template: string): string[] {
  return [...template.matchAll(SLOT_RE)].map((m) => m[1]!);
}
