/**
 * What a call used besides its phone line, gathered when it is costed: Twilio's speech relay (its minutes, and the
 * characters it synthesised), priced by the "relay" billing lines on the Twilio provider's own charging version, since
 * Twilio bills it; and the AI models the call's decisions used (their input and output tokens), each priced by the model
 * provider for that model. The cost record is then complete; none of it draws the client's credits, which follow the call.
 *
 * A call that used something with no rate to price it is refused with the reason, never costed with a guess: it can be
 * costed again once the rate exists.
 */
import type pg from 'pg';
import type { Usage } from '../billing.js';
import { AppError } from '../errors.js';

type CallRow = { id: string; provider_id: string; ended_at: Date; duration_seconds: string | number | null };

type Item = { providerId: string; usage: Usage; relay?: boolean };

export async function speechAndModelUsage(c: pg.PoolClient, call: CallRow): Promise<Item[]> {
  return [...await relayUsage(c, call), ...await modelUsage(c, call)];
}

/**
 * The speech relay's time on the call, from the first time it connected to the last time it closed (or the end of the
 * call, if sooner), and the characters it synthesised: every line said (a recording costs nothing to synthesise) and
 * every line said again when a reconnected line took the call over.
 */
async function relayUsage(c: pg.PoolClient, call: CallRow): Promise<Item[]> {
  const span = (await c.query(
    `SELECT min(occurred_at) FILTER (WHERE type = 'relay.connected') AS started,
            max(occurred_at) FILTER (WHERE type = 'relay.connected') AS last_connected,
            max(occurred_at) FILTER (WHERE type = 'relay.closed') AS closed
       FROM call_events WHERE call_id = $1 AND type IN ('relay.connected', 'relay.closed')`, [call.id])).rows[0];
  if (!span?.started) return [];
  const ended = new Date(call.ended_at).getTime();
  // A connection that took the call over after the last recorded close never recorded its own (a server stopped): the
  // relay ran to the end of the call.
  const closedLast = span.closed && new Date(span.closed).getTime() >= new Date(span.last_connected).getTime();
  const until = closedLast ? Math.min(new Date(span.closed).getTime(), ended) : ended;
  const seconds = Math.min(Math.max(0, (until - new Date(span.started).getTime()) / 1000), Number(call.duration_seconds ?? 0));
  const chars = (await c.query(
    `SELECT (SELECT coalesce(sum((s.payload->>'synthChars')::bigint), 0) FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
              WHERE r.call_id = $1 AND r.kind = 'live' AND s.type = 'say')
          + (SELECT coalesce(sum((payload->>'synthChars')::bigint), 0) FROM call_events WHERE call_id = $1 AND type = 'relay.said_again') AS n`,
    [call.id])).rows[0].n;
  return [{ providerId: call.provider_id, usage: { seconds, characters: Number(chars) }, relay: true }];
}

/**
 * Work about a call that is not part of it: scoring it afterwards and the learning loop run in batches, later, and are
 * the platform's own running cost, not this call's.
 */
const NOT_THE_CALL = ['qa_judge', 'qa_score', 'distill_script'];
const AFTER_THE_CALL_MS = 2 * 60_000;

/**
 * The tokens the call's own decisions used (while it was on, or a reply landing just after it ended), by model, each
 * priced by the model provider for that model, whatever its status now: its dated rates decide the price.
 */
async function modelUsage(c: pg.PoolClient, call: CallRow): Promise<Item[]> {
  const rows = (await c.query(
    `SELECT model, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output FROM ai_decisions
      WHERE call_id = $1 AND (input_tokens > 0 OR output_tokens > 0) AND task <> ALL($2) AND task NOT LIKE 'council\_%'
        AND at <= $3::timestamptz + make_interval(secs => $4)
      GROUP BY model ORDER BY model NULLS FIRST`, [call.id, NOT_THE_CALL, call.ended_at, AFTER_THE_CALL_MS / 1000])).rows as { model: string | null; input: string; output: string }[];
  const out: Item[] = [];
  for (const r of rows) {
    if (!r.model) throw new AppError(409, 'A decision on this call used tokens but names no model, so they cannot be priced.');
    const ps = (await c.query(`SELECT id FROM providers WHERE kind = 'model' AND params->>'model' = $1`, [r.model])).rows;
    if (ps.length !== 1) {
      throw new AppError(409, `This call used the model "${r.model}", which no model provider prices. Add one with its rates, then cost the call again.`);
    }
    out.push({ providerId: ps[0].id as string, usage: { inputTokens: Number(r.input), outputTokens: Number(r.output) } });
  }
  return out;
}
