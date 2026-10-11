/**
 * The voice usage of a call, for its one cost record (owner's decisions, 2026-10-11): the characters synthesised for
 * it, priced at the per-character rate of the voice provider its telephony provider's speech relay speaks with, and the
 * tokens its model decisions used, priced at each model's rate in force when the call started. Recordings cost nothing
 * to synthesise. Nothing here guesses: speech with no voice provider to price it, or tokens of a model with no rate,
 * refuse the cost.
 */
import type pg from 'pg';
import { AppError } from '../errors.js';
import { audit } from './audit.js';

/**
 * Tasks whose model decisions are made on the call itself, while it is under way. Work done about a call afterwards
 * (QA scoring, councils, distilling scripts) runs in batches and is the platform's cost, not the call's.
 */
export const CALL_PATH_TASKS = ['speak_dynamic'] as const;

/**
 * Characters synthesised for a call: every line its live runs said (the part not played from a recording), and every
 * line the relay's voice said outside the workflow (said again on a takeover, the wait line, the holding message). The
 * per-step count is the one the stitching panel sums.
 */
export async function callSynthCharacters(c: pg.PoolClient, callId: string): Promise<number> {
  const said = (await c.query(
    `SELECT coalesce(sum((s.payload->>'synthChars')::bigint), 0)::text AS n
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE r.call_id = $1 AND r.kind = 'live' AND s.type = 'say'`, [callId])).rows[0].n as string;
  // Lines the relay's voice speaks outside the workflow: said again on a takeover, the wait line, the holding message.
  const again = (await c.query(
    `SELECT coalesce(sum((payload->>'synthChars')::bigint), 0)::text AS n FROM call_events
      WHERE call_id = $1 AND type IN ('relay.said_again', 'relay.wait_line', 'relay.holding_message')`, [callId])).rows[0].n as string;
  return Number(BigInt(said) + BigInt(again));
}

export interface ModelUsage { model: string; inputTokens: number; outputTokens: number }

/** Tokens the call's own model decisions used, by model. A decision that used tokens without naming its model is refused. */
export async function callModelUsage(c: pg.PoolClient, callId: string): Promise<ModelUsage[]> {
  const rows = (await c.query(
    `SELECT model, sum(input_tokens)::bigint::text AS input, sum(output_tokens)::bigint::text AS output
       FROM ai_decisions WHERE call_id = $1 AND task = ANY($2) GROUP BY model ORDER BY model NULLS FIRST`,
    [callId, [...CALL_PATH_TASKS]])).rows as { model: string | null; input: string; output: string }[];
  const used = rows.filter((r) => BigInt(r.input) > 0n || BigInt(r.output) > 0n);
  // Tokens with no model are priced under the name "unnamed": refused until a person decides its rate, never guessed.
  return used.map((r) => ({ model: r.model ?? UNNAMED_MODEL, inputTokens: Number(r.input), outputTokens: Number(r.output) }));
}

// ------------------------------------------------------------------------------------------------ model rates
/** How a model may be named: as its provider names it, gateway (`vendor/model`) and dated (`model@date`) names included. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
/**
 * The name tokens are priced under when a decision used them without naming its model. Nothing is guessed: such tokens
 * refuse the cost until a person enters a rate for this name, which is the recorded way to settle them.
 */
export const UNNAMED_MODEL = 'unnamed';
const AMOUNT = /^\d{1,10}(\.\d{1,8})?$/;

export interface ModelRateInput { model: string; effectiveFrom: Date; inputPer1m: string; outputPer1m: string; currency: string }

/** Enter a model's price per million tokens from a date. A price change is a new row; none is ever edited. */
export async function addModelRate(c: pg.PoolClient, actorId: string | null, e: ModelRateInput) {
  if (!MODEL_NAME.test(e.model)) throw new AppError(400, 'A model is named as its provider names it: letters, digits and . _ : / @ - [ ] (up to 200).');
  for (const [k, v] of [['input', e.inputPer1m], ['output', e.outputPer1m]] as const) {
    if (!AMOUNT.test(v)) throw new AppError(400, `The ${k} price must be a plain amount, such as 1 or 0.25, with at most 8 decimal places.`);
  }
  if (!/^[A-Z]{3}$/.test(e.currency)) throw new AppError(400, 'The currency is a three-letter code, such as USD.');
  if (Number.isNaN(e.effectiveFrom.getTime())) throw new AppError(400, 'That is not a date.');
  const clash = (await c.query('SELECT 1 FROM model_rates WHERE model = $1 AND effective_from = $2', [e.model, e.effectiveFrom])).rowCount;
  if (clash) throw new AppError(409, 'This model already has a price from that moment. Enter a new price from a later moment.');
  const row = (await c.query(
    `INSERT INTO model_rates (model, effective_from, input_per_1m, output_per_1m, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, model, effective_from, input_per_1m, output_per_1m, currency, created_at`,
    [e.model, e.effectiveFrom, e.inputPer1m, e.outputPer1m, e.currency, actorId])).rows[0];
  await audit(c, actorId, 'model_rate.add', 'model_rate', row.id, { model: e.model, inputPer1m: e.inputPer1m, outputPer1m: e.outputPer1m, currency: e.currency });
  return row;
}

export const listModelRates = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, model, effective_from, input_per_1m, output_per_1m, currency, created_at FROM model_rates ORDER BY model, effective_from DESC')).rows;

/** The model's price in force at a moment, or a refusal: tokens are never priced with a guess. */
export async function modelRateAt(c: pg.PoolClient, model: string, at: Date) {
  const r = (await c.query(
    'SELECT id, input_per_1m, output_per_1m, currency FROM model_rates WHERE model = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1',
    [model, at])).rows[0];
  if (!r) throw new AppError(409, `The model ${model} has no price in force at ${at.toISOString()}. Enter its rate before costing calls.`);
  return { id: r.id as string, inputRate: r.input_per_1m as string, outputRate: r.output_per_1m as string, currency: r.currency as string };
}

/**
 * The voice provider a telephony provider's live calls speak with, for pricing their speech. Only a voice provider can
 * be linked, checked when it is set; the change is audited. Null unlinks it.
 */
export async function setSpeechProvider(c: pg.PoolClient, actorId: string | null, telephonyProviderId: string, voiceProviderId: string | null) {
  const p = (await c.query('SELECT id, kind FROM providers WHERE id = $1 FOR UPDATE', [telephonyProviderId])).rows[0];
  if (!p) throw new AppError(404, 'Provider not found.');
  if (p.kind !== 'telephony') throw new AppError(400, 'Only a telephony provider speaks on live calls, so only one can be linked to a voice provider.');
  if (voiceProviderId !== null && !(await c.query(`SELECT 1 FROM providers WHERE id = $1 AND kind = 'voice'`, [voiceProviderId])).rowCount) {
    throw new AppError(400, 'That is not a voice provider. Link the voice provider whose per-character rate prices the speech.');
  }
  await c.query('UPDATE providers SET speech_provider_id = $2 WHERE id = $1', [telephonyProviderId, voiceProviderId]);
  await audit(c, actorId, 'provider.speech_voice', 'provider', telephonyProviderId, { voiceProviderId });
  return { providerId: telephonyProviderId, speechProviderId: voiceProviderId };
}
