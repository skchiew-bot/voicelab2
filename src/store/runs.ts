import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecrets } from '../secrets.js';
import type { Json, WorkflowDefinition } from '../workflows/definition.js';
import { PhoneInVariable, reply as engineReply, start as engineStart, type Deps, type RunState, type StepRecord } from '../workflows/engine.js';
import { callIntegration, type HttpDeps } from '../workflows/integrations.js';
import { referencesOf } from '../workflows/refs.js';
import { evaluateScenario, MAX_REPLIES, MAX_SCENARIOS, type Scenario, type ScenarioResult } from '../workflows/simulate.js';
import { audit } from './audit.js';
import { getWorkflow, liveVersionId, type Environment } from './workflows.js';

export interface RunDeps { pool: pg.Pool; key: Buffer; integrationHttp?: HttpDeps; speaker?: Deps['speaker'] }
export type RunKind = 'simulation' | 'test' | 'live';

const asInternal = <T>(d: RunDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.pool, { kind: 'internal' }, fn);

interface Resolved { entryName: string; entryVersionId: string; pins: Record<string, string>; defs: Record<string, WorkflowDefinition> }

/**
 * Everything a call can reach, fixed at the moment it starts: the entry workflow's version, and the version
 * live in the same environment of every workflow it hands over to or runs inside it. A later deploy or rollback
 * does not change a call already under way.
 */
async function resolvePins(c: pg.PoolClient, wf: { id: string; tenant_id: string; name: string }, env: Environment, entryVersionId?: string): Promise<Resolved> {
  const byName = new Map((await c.query('SELECT id, name FROM workflows WHERE tenant_id = $1', [wf.tenant_id])).rows.map((r) => [r.name as string, r.id as string]));
  const versionOf = async (workflowId: string, name: string): Promise<{ id: string; definition: WorkflowDefinition }> => {
    const id = await liveVersionId(c, workflowId, env);
    if (!id) throw new AppError(409, `"${name}" is not live in ${env}.`);
    return { id, definition: (await c.query('SELECT definition FROM workflow_versions WHERE id = $1', [id])).rows[0].definition };
  };

  let entry: { id: string; definition: WorkflowDefinition };
  if (entryVersionId) {
    const v = (await c.query('SELECT id, definition, valid FROM workflow_versions WHERE id = $1 AND workflow_id = $2', [entryVersionId, wf.id])).rows[0];
    if (!v) throw new AppError(404, 'That version does not belong to this workflow.');
    if (!v.valid) throw new AppError(400, 'That version has errors and cannot be run.');
    entry = { id: v.id, definition: v.definition };
  } else entry = await versionOf(wf.id, wf.name);

  const pins: Record<string, string> = { [wf.name]: entry.id };
  const defs: Record<string, WorkflowDefinition> = { [wf.name]: entry.definition };
  const queue = [wf.name];
  while (queue.length) {
    const name = queue.shift()!;
    for (const ref of referencesOf(defs[name]!)) {
      if (ref.workflow in defs) continue;
      const id = byName.get(ref.workflow);
      if (!id) throw new AppError(409, `"${ref.workflow}" (reached from "${name}") does not exist.`);
      const v = await versionOf(id, ref.workflow);
      pins[ref.workflow] = v.id; defs[ref.workflow] = v.definition; queue.push(ref.workflow);
    }
  }
  return { entryName: wf.name, entryVersionId: entry.id, pins, defs };
}

async function loadPinned(c: pg.PoolClient, pins: Record<string, string>): Promise<Record<string, WorkflowDefinition>> {
  const rows = (await c.query('SELECT id, definition FROM workflow_versions WHERE id = ANY($1::uuid[])', [Object.values(pins)])).rows;
  const byId = new Map(rows.map((r) => [r.id as string, r.definition as WorkflowDefinition]));
  return Object.fromEntries(Object.entries(pins).map(([name, id]) => [name, byId.get(id)!]));
}

/** The tenant's integrations, keys decrypted in memory for the length of the call. A staging run never writes to them. */
async function integrationsFor(c: pg.PoolClient, tenantId: string, key: Buffer, env: Environment, http?: HttpDeps): Promise<NonNullable<Deps['integrations']>> {
  const rows = (await c.query('SELECT id, name, base_url, auth_header, auth_secret FROM integrations WHERE tenant_id = $1', [tenantId])).rows;
  const cfgs = new Map(rows.map((r) => [r.name as string, { baseUrl: r.base_url as string, authHeader: r.auth_header as string | undefined,
    authSecret: r.auth_secret ? decryptSecrets(r.auth_secret, key, r.id).value : undefined }]));
  return {
    call: async (name, req) => {
      const cfg = cfgs.get(name);
      if (!cfg) throw new Error(`There is no integration named "${name}".`);
      if (env === 'staging' && req.method !== 'GET') throw new Error('Staging calls only read from integrations; a write is refused.');
      return callIntegration(cfg, req, http);
    },
  };
}

/** Integrations for a simulation: canned answers only. A simulation never touches a real system. */
const cannedIntegrations = (canned: Record<string, Json> = {}): NonNullable<Deps['integrations']> => ({
  call: async (name) => {
    if (!(name in canned)) throw new Error(`The scenario has no canned answer for "${name}", and simulations do not call real systems.`);
    return canned[name]!;
  },
});

async function persistSteps(c: pg.PoolClient, runId: string, from: number, records: StepRecord[]) {
  let seq = from;
  for (const r of records) {
    await c.query('INSERT INTO workflow_run_steps (run_id, seq, type, workflow, node, payload) VALUES ($1,$2,$3,$4,$5,$6)', [runId, seq++, r.type, r.workflow, r.node ?? null, JSON.stringify(r.payload)]);
  }
}

const saidIn = (records: StepRecord[]) => records.filter((r) => r.type === 'say').map((r) => String(r.payload.text));
const view = (id: string, state: RunState, records: StepRecord[], version = 0) => ({
  id, version, status: state.status, outcome: state.outcome ?? null, error: state.error ?? null, said: saidIn(records), variables: state.vars,
  awaiting: state.awaiting ? { captureAs: state.awaiting.captureAs } : null,
});

/** Start a call through a workflow. It runs until it needs the caller or finishes. */
export async function startRun(d: RunDeps, actorId: string | null, e: { workflowId: string; environment: Environment; kind: RunKind; variables: Record<string, Json> }) {
  if (e.kind === 'simulation') throw new AppError(400, 'Use the simulation endpoint for simulations.');
  if (e.kind === 'live' && e.environment !== 'production') throw new AppError(400, 'Live calls run in production only.');
  const ctx = await asInternal(d, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    const resolved = await resolvePins(c, wf, e.environment);
    return { wf, resolved, integrations: await integrationsFor(c, wf.tenant_id, d.key, e.environment, d.integrationHttp) };
  });
  const deps: Deps = { load: (n) => ctx.resolved.defs[n], integrations: ctx.integrations, speaker: d.speaker };
  let out: { state: RunState; records: StepRecord[] };
  try { out = await engineStart(ctx.resolved.entryName, e.variables, deps); }
  catch (err) { if (err instanceof PhoneInVariable) throw new AppError(400, err.message); throw err; }

  return asInternal(d, async (c) => {
    const id = (await c.query(
      `INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, environment, kind, pins, state, status, outcome, error, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $8 = 'ended' THEN now() END) RETURNING id`,
      [ctx.wf.tenant_id, ctx.wf.id, ctx.resolved.entryVersionId, e.environment, e.kind, JSON.stringify(ctx.resolved.pins), JSON.stringify(out.state),
        out.state.status, out.state.outcome ?? null, out.state.error ?? null])).rows[0].id as string;
    await persistSteps(c, id, 1, out.records);
    await audit(c, actorId, 'workflow.run', 'workflow', ctx.wf.id, { run: id, kind: e.kind, environment: e.environment });
    return view(id, out.state, out.records);
  });
}

/** The caller said something. It is applied to the state the call was left in, and refused if the call has moved on meanwhile. */
export async function replyRun(d: RunDeps, runId: string, text: string, expectedVersion?: number) {
  const ctx = await asInternal(d, async (c) => {
    const run = (await c.query('SELECT * FROM workflow_runs WHERE id = $1', [runId])).rows[0];
    if (!run) throw new AppError(404, 'Run not found.');
    if (run.status !== 'awaiting_reply') throw new AppError(409, 'This call is not waiting for a reply.');
    // A reply that says which question it answers is refused if the call has since moved on to the next one.
    if (expectedVersion !== undefined && run.state_version !== expectedVersion) throw new AppError(409, 'The call has moved on since that question, so this reply was not applied.');
    const defs = await loadPinned(c, run.pins);
    return { run, defs, integrations: await integrationsFor(c, run.tenant_id, d.key, run.environment, d.integrationHttp) };
  });
  const deps: Deps = { load: (n) => ctx.defs[n], integrations: ctx.integrations, speaker: d.speaker };
  const out = await engineReply(ctx.run.state as RunState, text, deps);

  return asInternal(d, async (c) => {
    const upd = await c.query(
      `UPDATE workflow_runs SET state = $2, state_version = state_version + 1, status = $3, outcome = $4, error = $5,
              ended_at = CASE WHEN $3 = 'ended' THEN now() END
        WHERE id = $1 AND state_version = $6`,
      [runId, JSON.stringify(out.state), out.state.status, out.state.outcome ?? null, out.state.error ?? null, ctx.run.state_version]);
    if (upd.rowCount === 0) throw new AppError(409, 'This call moved on while your reply was being processed. Nothing was changed.');
    const last = (await c.query('SELECT coalesce(max(seq), 0) AS n FROM workflow_run_steps WHERE run_id = $1', [runId])).rows[0].n as number;
    await persistSteps(c, runId, last + 1, out.records);
    return view(runId, out.state, out.records, ctx.run.state_version + 1);
  });
}

export async function getRun(c: pg.PoolClient, runId: string) {
  const run = (await c.query(
    `SELECT id, tenant_id, workflow_id, version_id, environment, kind, batch_id, pins, status, outcome, error, started_at, ended_at, state
       FROM workflow_runs WHERE id = $1`, [runId])).rows[0];
  if (!run) throw new AppError(404, 'Run not found.');
  const steps = (await c.query('SELECT seq, type, workflow, node, payload, created_at FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq', [runId])).rows;
  return { ...run, variables: (run.state as RunState).vars, state: undefined, steps };
}

export const listRuns = async (c: pg.PoolClient, workflowId: string, limit = 50) =>
  (await c.query(
    `SELECT r.id, r.environment, r.kind, r.status, r.outcome, r.error, r.started_at, v.major || '.' || v.minor AS version
       FROM workflow_runs r JOIN workflow_versions v ON v.id = r.version_id WHERE r.workflow_id = $1 ORDER BY r.started_at DESC LIMIT $2`, [workflowId, limit])).rows;

/**
 * Run a list of scripted callers through a version in staging. Nothing real is touched: integrations answer from
 * the scenario. A clean batch (every scenario passing) is what lets that version go to production.
 */
export async function simulate(d: RunDeps, actorId: string | null, e: { workflowId: string; versionId?: string; scenarios: Scenario[] }) {
  if (e.scenarios.length === 0) throw new AppError(400, 'Give at least one scenario.');
  if (e.scenarios.length > MAX_SCENARIOS) throw new AppError(400, `At most ${MAX_SCENARIOS} scenarios in one simulation.`);
  if (e.scenarios.some((s) => (s.replies?.length ?? 0) > MAX_REPLIES)) throw new AppError(400, `At most ${MAX_REPLIES} replies per scenario.`);

  const ctx = await asInternal(d, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    return { wf, resolved: await resolvePins(c, wf, 'staging', e.versionId) };
  });

  const runs: { scenario: Scenario; state: RunState; records: StepRecord[]; unused: number }[] = [];
  for (const s of e.scenarios) {
    const deps: Deps = { load: (n) => ctx.resolved.defs[n], integrations: cannedIntegrations(s.integrations), speaker: d.speaker };
    try {
      let { state, records } = await engineStart(ctx.resolved.entryName, s.variables, deps);
      const all = [...records]; const replies = [...(s.replies ?? [])];
      while (state.status === 'awaiting_reply' && replies.length) {
        const r = await engineReply(state, replies.shift()!, deps);
        state = r.state; all.push(...r.records);
      }
      runs.push({ scenario: s, state, records: all, unused: replies.length });
    } catch (err) {
      if (!(err instanceof PhoneInVariable)) throw err;
      // A scenario that carries a phone number is a failed scenario, not a failed simulation.
      const state: RunState = { workflow: ctx.resolved.entryName, node: null, vars: {}, stack: [], status: 'ended', outcome: 'error', error: err.message, steps: 0, sensitive: [] };
      runs.push({ scenario: s, state, records: [{ type: 'error', workflow: ctx.resolved.entryName, payload: { message: err.message } }], unused: 0 });
    }
  }

  return asInternal(d, async (c) => {
    const results: ScenarioResult[] = runs.map((r) => evaluateScenario(r.scenario, { state: r.state, records: r.records, unusedReplies: r.unused }));
    // Run ids are chosen first so the batch, which can never be edited, is written once with its complete results.
    const ids = runs.map(() => randomUUID());
    results.forEach((r, i) => { r.runId = ids[i]; });
    const passed = results.filter((r) => r.passed).length;
    const batch = (await c.query(
      `INSERT INTO simulation_batches (workflow_id, version_id, total, passed, failed, results, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [ctx.wf.id, ctx.resolved.entryVersionId, results.length, passed, results.length - passed, JSON.stringify(results), actorId])).rows[0];
    for (const [i, r] of runs.entries()) {
      await c.query(
        `INSERT INTO workflow_runs (id, tenant_id, workflow_id, version_id, environment, kind, batch_id, pins, state, status, outcome, error, ended_at)
         VALUES ($1,$2,$3,$4,'staging','simulation',$5,$6,$7,$8,$9,$10, now())`,
        [ids[i], ctx.wf.tenant_id, ctx.wf.id, ctx.resolved.entryVersionId, batch.id, JSON.stringify(ctx.resolved.pins), JSON.stringify(r.state), r.state.status, r.state.outcome ?? null, r.state.error ?? null]);
      await persistSteps(c, ids[i]!, 1, r.records);
    }
    return { batchId: batch.id as string, versionId: ctx.resolved.entryVersionId, total: results.length, passed, failed: results.length - passed, clean: passed === results.length, results };
  });
}
