import type pg from 'pg';
import { AppError } from '../errors.js';
import { classifyEnd } from '../journey/ending.js';
import type { RunState } from '../workflows/engine.js';
import { audit } from './audit.js';
import { dropLatencySeconds } from './journey.js';
import { recordEvent } from './events.js';
import { ticketForFault } from './tickets.js';

/**
 * Record how a finished call ended: who ended it, at which node, and whether the system dropped it. A fault is
 * flagged on the call (the Control Tower shows it as an alert straight away) and gets its own ticket.
 */
export async function recordCallEnd(
  c: pg.PoolClient,
  call: { id: string; tenant_id: string; project_id: string | null; answered_at: Date | null },
  ev: { endReason?: string; occurredAt: Date; answered?: boolean },
) {
  const run = (await c.query(
    `SELECT id, status, outcome, error, state FROM workflow_runs WHERE call_id = $1 ORDER BY started_at DESC LIMIT 1`, [call.id])).rows[0];
  const state = run?.state as RunState | undefined;
  // Where the workflow was: the node it was waiting at, else the last node it did anything at.
  const lastNode = run ? ((await c.query('SELECT node FROM workflow_run_steps WHERE run_id = $1 AND node IS NOT NULL ORDER BY seq DESC LIMIT 1', [run.id])).rows[0]?.node as string | undefined) : undefined;
  const end = classifyEnd({
    endReason: ev.endReason, answered: ev.answered ?? call.answered_at !== null,
    run: run ? { status: run.status, outcome: run.outcome, error: run.error, node: state?.awaiting?.node ?? state?.node ?? lastNode ?? null } : undefined,
  });
  await c.query(
    // A fault already flagged (by the watchdog) stays flagged, with its reason and the time it was first seen.
    `UPDATE calls SET ended_by = $2, ended_node = $3,
            fault_reason = CASE WHEN $4 AND NOT fault THEN $5 ELSE fault_reason END,
            fault_at = CASE WHEN $4 AND NOT fault THEN now() ELSE fault_at END,
            fault = fault OR $4
      WHERE id = $1`,
    [call.id, end.endedBy, end.node, end.fault, end.fault ? end.reason : null]);
  // A call no workflow ran on has nothing to say about who ended it, unless the system dropped it.
  if (run || end.fault) {
    await recordEvent(c, {
      tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId: call.id, type: end.fault ? 'call.fault' : 'call.end_classified',
      payload: { endedBy: end.endedBy, node: end.node, fault: end.fault, reason: end.reason }, occurredAt: ev.occurredAt,
    });
  }
  if (end.fault) await ticketForFault(c, null, call.id, end.reason);
  return end;
}

/**
 * Find calls the system dropped without any end event: the workflow failed (or stalled mid-step) while the call stayed
 * open. Run on a schedule; a fault is flagged once the failure is older than the agreed latency, so a drop is never
 * unflagged for longer than that plus the interval between runs.
 */
/** A reply may take this long to work out before the watchdog calls the call dropped, whatever latency was agreed. */
export const WORKING_FLOOR_SECONDS = 180;

export async function sweepFaults(c: pg.PoolClient, now = new Date()) {
  const latency = await dropLatencySeconds(c);
  const cutoff = new Date(now.getTime() - latency * 1000);
  // A reply being worked on can legitimately take a while (a slow integration or model): it is judged against a floor.
  const workingCutoff = new Date(now.getTime() - Math.max(latency, WORKING_FLOOR_SECONDS) * 1000);
  const rows = (await c.query(
    `WITH locked AS (
       SELECT id FROM calls k WHERE k.status IN ('in_progress', 'ringing') AND k.ended_at IS NULL AND NOT k.fault
          AND EXISTS (SELECT 1 FROM workflow_runs q WHERE q.call_id = k.id
                       AND ((q.status = 'ended' AND q.outcome IN ('error', 'integration_failed') AND q.ended_at < $1)
                         OR (q.status IN ('running', 'processing') AND q.updated_at < $2)))
          FOR UPDATE OF k SKIP LOCKED)
     SELECT DISTINCT ON (c.id) c.id, c.tenant_id, c.project_id, r.status, r.outcome, r.error, r.state
       FROM calls c JOIN locked l ON l.id = c.id JOIN workflow_runs r ON r.call_id = c.id
      WHERE c.status IN ('in_progress', 'ringing') AND c.ended_at IS NULL AND NOT c.fault
        AND ((r.status = 'ended' AND r.outcome IN ('error', 'integration_failed') AND r.ended_at < $1)
          OR (r.status IN ('running', 'processing') AND r.updated_at < $2))
      ORDER BY c.id, r.started_at DESC`, [cutoff, workingCutoff])).rows;
  const flagged: string[] = [];
  for (const r of rows) {
    const reason = r.status === 'ended' ? `The workflow failed (${r.error ?? r.outcome}) but the call was left open.` : 'The workflow stopped responding mid-step and the call was left open.';
    const node = (r.state as RunState | undefined)?.node ?? null;
    await c.query(`UPDATE calls SET fault = true, fault_reason = $2, fault_at = $3, ended_node = coalesce(ended_node, $4) WHERE id = $1`, [r.id, reason, now, node]);
    await recordEvent(c, { tenantId: r.tenant_id, projectId: r.project_id ?? undefined, callId: r.id, type: 'call.fault', payload: { reason, node, source: 'watchdog' }, occurredAt: now });
    await ticketForFault(c, null, r.id, reason);
    flagged.push(r.id as string);
  }
  return { latencySeconds: latency, flagged };
}

/** Calls the system dropped that nobody has looked at yet, newest first. */
export const listFaults = async (c: pg.PoolClient, o: { tenantId?: string; acknowledged?: boolean; limit?: number } = {}) =>
  (await c.query(
    `SELECT c.id, c.tenant_id, c.direction, c.status, c.ended_node, c.fault_reason, c.fault_at, c.ended_at, c.started_at,
            (a.call_id IS NOT NULL) AS acknowledged,
            round(extract(epoch FROM (c.fault_at - coalesce(c.ended_at, c.fault_at))) * 1000)::bigint AS flagged_after_ms
       FROM calls c LEFT JOIN fault_acks a ON a.call_id = c.id
      WHERE c.fault AND ($1::uuid IS NULL OR c.tenant_id = $1) AND ($2::boolean IS NULL OR (a.call_id IS NOT NULL) = $2)
      ORDER BY c.fault_at DESC LIMIT $3`, [o.tenantId ?? null, o.acknowledged ?? null, o.limit ?? 50])).rows;

export async function ackFault(c: pg.PoolClient, actorId: string | null, callId: string, note?: string) {
  const call = (await c.query('SELECT fault FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call) throw new AppError(404, 'Call not found.');
  if (!call.fault) throw new AppError(409, 'That call is not flagged as a fault.');
  await c.query('INSERT INTO fault_acks (call_id, acked_by, note) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [callId, actorId, note ?? null]);
  await audit(c, actorId, 'fault.ack', 'call', callId, {});
  return { acknowledged: true };
}
