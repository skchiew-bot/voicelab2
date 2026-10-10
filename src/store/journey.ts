import type pg from 'pg';
import { AppError } from '../errors.js';
import { DEFAULT_JOURNEY, mergeLexicon, type JourneyConfig, type Lexicon } from '../journey/tracker.js';
import { audit } from './audit.js';

const LEXICON_KEYS = ['complaint', 'request', 'inquiry', 'positive', 'negative', 'severe', 'negators'] as const;

/** A client's lexicon additions: lists of short phrases, bounded so a configuration cannot slow every turn. */
export function validateLexicon(input: unknown): Partial<Lexicon> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'The lexicon must be an object.');
  const o = input as Record<string, unknown>;
  const list = (v: unknown, where: string): string[] => {
    if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 60)) throw new AppError(400, `${where} must be a list of up to 200 short phrases.`);
    return v.map((x: string) => x.trim());
  };
  const out: Partial<Lexicon> = {};
  for (const k of Object.keys(o)) if (k !== 'topics' && !(LEXICON_KEYS as readonly string[]).includes(k)) throw new AppError(400, `"${k}" is not something a lexicon can hold.`);
  for (const k of LEXICON_KEYS) if (o[k] !== undefined) out[k] = list(o[k], k);
  if (o.topics !== undefined) {
    if (typeof o.topics !== 'object' || o.topics === null || Array.isArray(o.topics) || Object.keys(o.topics).length > 50) throw new AppError(400, 'topics must be an object of at most 50 topics.');
    out.topics = {};
    for (const [name, v] of Object.entries(o.topics as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new AppError(400, `"${name}" is not a topic name.`);
      out.topics[name] = list(v, `topics.${name}`);
    }
  }
  return out;
}

export async function getJourneyConfig(c: pg.PoolClient, tenantId: string): Promise<JourneyConfig> {
  const r = (await c.query('SELECT max_recoveries, negative_below, severe_below, lexicon FROM journey_config WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!r) return DEFAULT_JOURNEY;
  return { maxRecoveries: r.max_recoveries, negativeBelow: Number(r.negative_below), severeBelow: Number(r.severe_below), lexicon: mergeLexicon(r.lexicon) };
}

export async function setJourneyConfig(
  c: pg.PoolClient, actorId: string | null, tenantId: string,
  e: { maxRecoveries?: number; negativeBelow?: number; severeBelow?: number; lexicon?: unknown },
) {
  const lex = validateLexicon(e.lexicon);
  const cur = (await c.query('SELECT * FROM journey_config WHERE tenant_id = $1', [tenantId])).rows[0];
  const next = {
    max_recoveries: e.maxRecoveries ?? cur?.max_recoveries ?? 2, negative_below: e.negativeBelow ?? cur?.negative_below ?? -0.3,
    severe_below: e.severeBelow ?? cur?.severe_below ?? -0.75, lexicon: e.lexicon === undefined ? cur?.lexicon ?? {} : lex,
  };
  if (Number(next.severe_below) > Number(next.negative_below)) throw new AppError(400, 'The severe level must be at or below the upset level.');
  await c.query(
    `INSERT INTO journey_config (tenant_id, max_recoveries, negative_below, severe_below, lexicon) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET max_recoveries = $2, negative_below = $3, severe_below = $4, lexicon = $5, updated_at = now()`,
    [tenantId, next.max_recoveries, next.negative_below, next.severe_below, JSON.stringify(next.lexicon)]);
  await audit(c, actorId, 'journey.config', 'tenant', tenantId, { maxRecoveries: next.max_recoveries, negativeBelow: Number(next.negative_below), severeBelow: Number(next.severe_below) });
  return getJourneyConfig(c, tenantId);
}

export async function dropLatencySeconds(c: pg.PoolClient): Promise<number> {
  return (await c.query('SELECT drop_alert_latency_s AS n FROM journey_settings WHERE id = 1')).rows[0]?.n ?? 60;
}
export async function setDropLatency(c: pg.PoolClient, actorId: string | null, seconds: number) {
  await c.query('UPDATE journey_settings SET drop_alert_latency_s = $1, updated_at = now() WHERE id = 1', [seconds]);
  await audit(c, actorId, 'journey.drop_latency', 'journey_settings', '1', { seconds });
  return seconds;
}
