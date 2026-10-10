import type pg from 'pg';
import { AppError } from '../errors.js';
import { buildReplay, type Replay } from '../journey/replay.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { eventsForCall } from './events.js';

/** Replay one workflow run, with the call it belonged to (its events, its end, any failover) when there is one. */
export async function replayRun(c: pg.PoolClient, runId: string): Promise<Replay> {
  const run = (await c.query(
    `SELECT r.id, r.call_id, r.pins, r.status, r.outcome, r.error, r.environment, r.kind, w.name AS entry FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1`, [runId])).rows[0];
  if (!run) throw new AppError(404, 'Run not found.');
  const steps = (await c.query('SELECT seq, type, workflow, node, payload, created_at, occurred_at FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq', [runId])).rows;
  const pins = run.pins as Record<string, string>;
  const versions = (await c.query(
    `SELECT v.id, v.definition, v.major || '.' || v.minor AS label FROM workflow_versions v WHERE v.id = ANY($1::uuid[])`, [Object.values(pins)])).rows;
  const byId = new Map(versions.map((v) => [v.id as string, v]));
  const definitions: Record<string, WorkflowDefinition> = {}; const labels: Record<string, string> = {};
  for (const [name, id] of Object.entries(pins)) { const v = byId.get(id); if (v) { definitions[name] = v.definition; labels[name] = v.label; } }
  const call = run.call_id ? await callInfo(c, run.call_id) : null;
  const events = run.call_id ? await eventsForCall(c, run.call_id) : [];
  const failovers = await failoversFor(c, run.call_id, runId);
  return buildReplay({
    run: { id: run.id, workflow: run.entry as string, status: run.status, outcome: run.outcome, error: run.error, environment: run.environment, kind: run.kind, versions: labels },
    steps, events, failovers, definitions, call,
  });
}

/** Replay a call: the workflow run it carried (the latest, if there were several), or its events alone if none. */
export async function replayCall(c: pg.PoolClient, callId: string): Promise<Replay> {
  const call = await callInfo(c, callId);
  if (!call) throw new AppError(404, 'Call not found.');
  const runId = (await c.query('SELECT id FROM workflow_runs WHERE call_id = $1 ORDER BY started_at DESC LIMIT 1', [callId])).rows[0]?.id as string | undefined;
  if (runId) return replayRun(c, runId);
  return buildReplay({ run: null, steps: [], events: await eventsForCall(c, callId), failovers: await failoversFor(c, callId, null), call });
}

async function callInfo(c: pg.PoolClient, callId: string) {
  return (await c.query(
    `SELECT id, status, direction, ended_by, ended_node, fault, fault_reason, started_at, ended_at FROM calls WHERE id = $1`, [callId])).rows[0] ?? null;
}

async function failoversFor(c: pg.PoolClient, callId: string | null, runId: string | null) {
  return (await c.query(
    `SELECT f.id, f.scope, f.trigger, f.detail, f.at, pf.name AS from_name, pt.name AS to_name
       FROM failover_events f LEFT JOIN providers pf ON pf.id = f.from_provider LEFT JOIN providers pt ON pt.id = f.to_provider
      WHERE ($1::uuid IS NOT NULL AND f.call_id = $1) OR ($2::uuid IS NOT NULL AND f.run_id = $2) ORDER BY f.id`, [callId, runId])).rows;
}
