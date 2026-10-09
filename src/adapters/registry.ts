import type { Adapter, ParamDef, ParamValues } from './types.js';
import { elevenlabs, openai, telnyx, twilio } from './definitions.js';

const adapters = new Map<string, Adapter>(
  [twilio, telnyx, openai, elevenlabs].map((a) => [a.key, a]),
);

export const listAdapters = (): Adapter[] => [...adapters.values()];
export const getAdapter = (key: string): Adapter | undefined => adapters.get(key);

export interface SplitParams {
  plain: Record<string, string | number | boolean>;
  secret: Record<string, string>;
}

/** Validate submitted values against an adapter's declaration and split secrets from plain values. */
export function checkParams(adapter: Adapter, values: ParamValues): { ok: true; split: SplitParams } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const known = new Set(adapter.params.map((p) => p.key));
  for (const key of Object.keys(values)) if (!known.has(key)) errors.push(`Unknown parameter "${key}".`);

  const split: SplitParams = { plain: {}, secret: {} };
  for (const def of adapter.params) {
    const raw = values[def.key];
    const empty = raw === undefined || raw === '';
    if (empty) {
      if (def.required) errors.push(`${def.label} is required.`);
      continue;
    }
    const err = typeError(def, raw);
    if (err) { errors.push(err); continue; }
    if (def.type === 'secret') split.secret[def.key] = String(raw);
    else split.plain[def.key] = raw;
  }
  if (errors.length === 0) {
    const cross = adapter.crossValidate?.(values);
    if (cross) errors.push(cross);
  }
  return errors.length ? { ok: false, errors } : { ok: true, split };
}

function typeError(def: ParamDef, raw: string | number | boolean): string | null {
  switch (def.type) {
    case 'number': return typeof raw === 'number' && Number.isFinite(raw) ? null : `${def.label} must be a number.`;
    case 'boolean': return typeof raw === 'boolean' ? null : `${def.label} must be true or false.`;
    case 'url':
      try { return new URL(String(raw)).protocol.startsWith('http') ? null : `${def.label} must be an http(s) URL.`; }
      catch { return `${def.label} must be a valid URL.`; }
    default: return typeof raw === 'string' ? null : `${def.label} must be text.`;
  }
}
