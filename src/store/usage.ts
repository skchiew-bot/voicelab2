/**
 * What a call used besides its phone line, gathered when it is costed: the speech relay (its minutes, and the characters
 * it synthesised) and the AI models the call's decisions used (their input and output tokens). Each is priced by its own
 * provider's dated rates, so the cost record is complete; none of it draws the client's credits, which follow the call.
 *
 * A call that used something with no rate to price it is refused with the reason, never costed with a guess: it can be
 * costed again once the rate exists.
 */
import type pg from 'pg';
import type { Usage } from '../billing.js';
import { AppError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CallRow = { id: string; provider_id: string; ended_at: Date; duration_seconds: string | number | null };

export async function speechAndModelUsage(c: pg.PoolClient, call: CallRow): Promise<{ providerId: string; usage: Usage }[]> {
  return [...await relayUsage(c, call), ...await modelUsage(c, call.id)];
}

/**
 * The speech relay's time on the call, from the first time it connected to the last time it closed (or the end of the
 * call, if sooner), and the characters it synthesised: every line said (a recording costs nothing to synthesise) and
 * every line said again when a reconnected line took the call over.
 */
async function relayUsage(c: pg.PoolClient, call: CallRow): Promise<{ providerId: string; usage: Usage }[]> {
  const span = (await c.query(
    `SELECT min(occurred_at) FILTER (WHERE type = 'relay.connected') AS started,
            max(occurred_at) FILTER (WHERE type = 'relay.closed') AS closed
       FROM call_events WHERE call_id = $1 AND type IN ('relay.connected', 'relay.closed')`, [call.id])).rows[0];
  if (!span?.started) return [];
  const params = (await c.query('SELECT params FROM providers WHERE id = $1', [call.provider_id])).rows[0]?.params ?? {};
  const pricing = typeof params.relayPricingProviderId === 'string' ? params.relayPricingProviderId : '';
  const voice = UUID.test(pricing) ? (await c.query(`SELECT id FROM providers WHERE id = $1 AND kind = 'voice'`, [pricing])).rows[0] : undefined;
  if (!voice) {
    throw new AppError(409, 'This call used the speech relay, but its Twilio provider names no voice provider to price it ("Live call speech pricing"). Set one, then cost the call again.');
  }
  const ended = new Date(call.ended_at).getTime();
  const until = span.closed ? Math.min(new Date(span.closed).getTime(), ended) : ended;
  const seconds = Math.min(Math.max(0, (until - new Date(span.started).getTime()) / 1000), Number(call.duration_seconds ?? 0));
  const chars = (await c.query(
    `SELECT (SELECT coalesce(sum((s.payload->>'synthChars')::bigint), 0) FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
              WHERE r.call_id = $1 AND r.kind = 'live' AND s.type = 'say')
          + (SELECT coalesce(sum((payload->>'synthChars')::bigint), 0) FROM call_events WHERE call_id = $1 AND type = 'relay.said_again') AS n`,
    [call.id])).rows[0].n;
  return [{ providerId: voice.id as string, usage: { seconds, characters: Number(chars) } }];
}

/** The tokens the call's decisions used, by model, each priced by the one model provider named for that model. */
async function modelUsage(c: pg.PoolClient, callId: string): Promise<{ providerId: string; usage: Usage }[]> {
  const rows = (await c.query(
    `SELECT model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output FROM ai_decisions
      WHERE call_id = $1 AND (input_tokens > 0 OR output_tokens > 0) GROUP BY model ORDER BY model NULLS FIRST`, [callId])).rows as { model: string | null; input: string; output: string }[];
  const out: { providerId: string; usage: Usage }[] = [];
  for (const r of rows) {
    if (!r.model) throw new AppError(409, 'A decision on this call used tokens but names no model, so they cannot be priced.');
    const ps = (await c.query(`SELECT id FROM providers WHERE kind = 'model' AND status = 'active' AND params->>'model' = $1`, [r.model])).rows;
    if (ps.length !== 1) {
      throw new AppError(409, ps.length === 0
        ? `This call used the model "${r.model}", which no active model provider prices. Add one with its rates, then cost the call again.`
        : `More than one active model provider prices "${r.model}", so which rate applies is unclear. Leave one active, then cost the call again.`);
    }
    out.push({ providerId: ps[0].id as string, usage: { inputTokens: Number(r.input), outputTokens: Number(r.output) } });
  }
  return out;
}
