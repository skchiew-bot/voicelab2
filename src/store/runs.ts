import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { lineAmount, quantityFor, type Unit } from '../billing.js';
import { fromScaled, mulDiv, SCALE } from '../money.js';
import { decryptSecrets, encryptSecrets } from '../secrets.js';
import { own, type Json, type WorkflowDefinition } from '../workflows/definition.js';
import { PhoneInVariable, reply as engineReply, start as engineStart, type Deps, type RunState, type StepRecord } from '../workflows/engine.js';
import { callIntegration, type HttpDeps } from '../workflows/integrations.js';
import { referencesOf } from '../workflows/refs.js';
import { chargingAt } from './charging.js';
import { perUsd } from './costs.js';
import { evaluateScenario, gateProblems, MAX_REPLIES, MAX_SCENARIOS, type Scenario, type ScenarioResult } from '../workflows/simulate.js';
import { audit } from './audit.js';
import { recordStepDecisions } from './ai-decisions.js';
import { caseVariables } from './cases.js';
import { publishedArticles } from './knowledge.js';
import { policyGuard } from './policy.js';
import { rank } from '../knowledge/search.js';
import { activePromotions, logLearningTurns } from './learning.js';
import { getJourneyConfig } from './journey.js';
import { recordingIndex } from './recordings.js';
import { ticketForEscalation } from './tickets.js';
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
export async function integrationsFor(c: pg.PoolClient, tenantId: string, key: Buffer, env: Environment, http?: HttpDeps): Promise<NonNullable<Deps['integrations']>> {
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
    await c.query('INSERT INTO workflow_run_steps (run_id, seq, type, workflow, node, payload, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [runId, seq++, r.type, r.workflow, r.node ?? null, JSON.stringify(r.payload), r.at ?? null]);
  }
}

/**
 * While a call waits for the caller, its sensitive variables are not kept in the readable state: they are sealed
 * (AES-256-GCM, bound to this run) and put back only when the call resumes. A call that has ended keeps none.
 */
function seal(state: RunState, key: Buffer, runId: string): { state: RunState; sealed: Buffer | null } {
  const held = state.status === 'ended' ? [] : state.sensitive.filter((n) => own(state.vars, n));
  const vars = Object.fromEntries(Object.entries(state.vars).filter(([k]) => !state.sensitive.includes(k)));
  const sealed = held.length ? encryptSecrets(Object.fromEntries(held.map((n) => [n, JSON.stringify(state.vars[n])])), key, `run:${runId}`) : null;
  return { state: { ...state, vars }, sealed };
}

function unseal(state: RunState, sealed: Buffer | null, key: Buffer, runId: string): RunState {
  if (!sealed) return state;
  const held = decryptSecrets(sealed, key, `run:${runId}`);
  return { ...state, vars: { ...state.vars, ...Object.fromEntries(Object.entries(held).map(([k, v]) => [k, JSON.parse(v) as Json])) } };
}

/** The kind and topic of the caller's latest turn: the journey context a line was spoken in. */
const contextOf = (state: RunState) => { const t = state.journey?.turns.at(-1); return { kind: t?.kind ?? 'start', topic: t?.topic ?? null }; };
const saidIn = (records: StepRecord[]) => records.filter((r) => r.type === 'say').map((r) => String(r.payload.text));
const speechOf = (records: { type: string; payload: Record<string, Json> }[]) => records.filter((r) => r.type === 'say').reduce(
  (t, r) => ({ synthChars: t.synthChars + Number(r.payload.synthChars ?? 0), recordedChars: t.recordedChars + Number(r.payload.recordedChars ?? 0) }), { synthChars: 0, recordedChars: 0 });
const view = (id: string, state: RunState, records: StepRecord[], version = 0) => ({ speech: speechOf(records),
  id, version, status: state.status, outcome: state.outcome ?? null, error: state.error ?? null, said: saidIn(records), variables: Object.fromEntries(Object.entries(state.vars).filter(([k]) => !state.sensitive.includes(k))),
  awaiting: state.awaiting ? { captureAs: state.awaiting.captureAs } : null,
});

/** Start a call through a workflow. It runs until it needs the caller or finishes. */
export async function startRun(d: RunDeps, actorId: string | null, e: { workflowId: string; environment: Environment; kind: RunKind; variables: Record<string, Json>; callId?: string }) {
  if (e.kind === 'simulation') throw new AppError(400, 'Use the simulation endpoint for simulations.');
  if (e.kind === 'live' && e.environment !== 'production') throw new AppError(400, 'Live calls run in production only.');
  const ctx = await asInternal(d, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    const resolved = await resolvePins(c, wf, e.environment);
    let caseVars: Record<string, Json> = {};
    if (e.callId) {
      const call = (await c.query('SELECT tenant_id, case_id FROM calls WHERE id = $1', [e.callId])).rows[0];
      if (!call || call.tenant_id !== wf.tenant_id) throw new AppError(404, 'That call does not belong to this workflow\'s client.');
      // A call that belongs to a case carries on where the case left off; the caller's own variables win.
      if (call.case_id) caseVars = await caseVariables(c, call.case_id);
    }
    return { wf, resolved, integrations: await integrationsFor(c, wf.tenant_id, d.key, e.environment, d.integrationHttp), recordings: await recordingIndex(c, wf.tenant_id), journey: await getJourneyConfig(c, wf.tenant_id), promoted: await activePromotions(c, wf.tenant_id), caseVars, articles: await publishedArticles(c, wf.tenant_id), policy: await policyGuard(c, wf.tenant_id) };
  });
  const deps: Deps = { load: (n) => ctx.resolved.defs[n], integrations: ctx.integrations, speaker: d.speaker, recordings: ctx.recordings, journey: ctx.journey, promoted: ctx.promoted, policy: ctx.policy, knowledge: (q, lang) => rank(ctx.articles, q, { language: lang, channel: 'voice', limit: 3 }) };
  let out: { state: RunState; records: StepRecord[] };
  try { out = await engineStart(ctx.resolved.entryName, { ...ctx.caseVars, ...e.variables }, deps); }
  catch (err) { if (err instanceof PhoneInVariable) throw new AppError(400, err.message); throw err; }

  return asInternal(d, async (c) => {
    const id = randomUUID();
    const held = seal(out.state, d.key, id);
    await c.query(
      `INSERT INTO workflow_runs (id, tenant_id, workflow_id, version_id, environment, kind, pins, state, sealed, status, outcome, error, ended_at, call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $10 = 'ended' THEN now() END, $13)`,
      [id, ctx.wf.tenant_id, ctx.wf.id, ctx.resolved.entryVersionId, e.environment, e.kind, JSON.stringify(ctx.resolved.pins), JSON.stringify(held.state), held.sealed,
        out.state.status, out.state.outcome ?? null, out.state.error ?? null, e.callId ?? null]);
    await persistSteps(c, id, 1, out.records);
    await recordStepDecisions(c, { tenantId: ctx.wf.tenant_id, callId: e.callId ?? null, runId: id, records: out.records });
    await logLearningTurns(c, { tenantId: ctx.wf.tenant_id, runId: id, callId: e.callId ?? null, kind: e.kind, records: out.records, vars: out.state.vars, sensitive: out.state.sensitive, context: contextOf(out.state) });
    if (out.state.escalation || out.state.outcome === 'handoff_human') await ticketForEscalation(c, actorId, id);
    await audit(c, actorId, 'workflow.run', 'workflow', ctx.wf.id, { run: id, kind: e.kind, environment: e.environment });
    return view(id, out.state, out.records);
  });
}

/**
 * The caller said something. It is applied to the state the call was left in, and refused if the call has moved on
 * meanwhile. The turn is claimed before anything runs, so two replies cannot both act on the same question (and so
 * cannot both fire the same write to an integration).
 */
export async function replyRun(d: RunDeps, runId: string, text: string, expectedVersion?: number) {
  const ctx = await asInternal(d, async (c) => {
    const run = (await c.query('SELECT * FROM workflow_runs WHERE id = $1', [runId])).rows[0];
    if (!run) throw new AppError(404, 'Run not found.');
    if (run.status !== 'awaiting_reply') throw new AppError(409, run.status === 'processing' ? 'A reply to this call is already being applied.' : 'This call is not waiting for a reply.');
    // A reply that says which question it answers is refused if the call has since moved on to the next one.
    if (expectedVersion !== undefined && run.state_version !== expectedVersion) throw new AppError(409, 'The call has moved on since that question, so this reply was not applied.');
    const claim = await c.query(
      `UPDATE workflow_runs SET status = 'processing', claimed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'awaiting_reply' AND state_version = $2`, [runId, run.state_version]);
    if (claim.rowCount === 0) throw new AppError(409, 'This call moved on while your reply was arriving. Nothing was changed.');
    const defs = await loadPinned(c, run.pins);
    return { run, defs, integrations: await integrationsFor(c, run.tenant_id, d.key, run.environment, d.integrationHttp), recordings: await recordingIndex(c, run.tenant_id), journey: await getJourneyConfig(c, run.tenant_id), promoted: await activePromotions(c, run.tenant_id), articles: await publishedArticles(c, run.tenant_id), policy: await policyGuard(c, run.tenant_id) };
  });
  const deps: Deps = { load: (n) => ctx.defs[n], integrations: ctx.integrations, speaker: d.speaker, recordings: ctx.recordings, journey: ctx.journey, promoted: ctx.promoted, policy: ctx.policy, knowledge: (q, lang) => rank(ctx.articles, q, { language: lang, channel: 'voice', limit: 3 }) };
  let out: { state: RunState; records: StepRecord[] };
  try { out = await engineReply(unseal(ctx.run.state as RunState, ctx.run.sealed, d.key, runId), text, deps); }
  catch (err) {
    // Nothing was applied: hand the turn back so the caller can be asked again.
    await asInternal(d, (c) => c.query(`UPDATE workflow_runs SET status = 'awaiting_reply', claimed_at = NULL, updated_at = now() WHERE id = $1 AND status = 'processing'`, [runId]));
    throw err;
  }

  return asInternal(d, async (c) => {
    const held = seal(out.state, d.key, runId);
    const upd = await c.query(
      `UPDATE workflow_runs SET state = $2, sealed = $7, state_version = state_version + 1, status = $3, outcome = $4, error = $5, claimed_at = NULL, updated_at = now(),
              ended_at = CASE WHEN $3 = 'ended' THEN now() END
        WHERE id = $1 AND state_version = $6 AND status = 'processing'`,
      [runId, JSON.stringify(held.state), out.state.status, out.state.outcome ?? null, out.state.error ?? null, ctx.run.state_version, held.sealed]);
    if (upd.rowCount === 0) throw new AppError(409, 'This call was closed while your reply was being processed. Nothing was changed.');
    const last = (await c.query('SELECT coalesce(max(seq), 0) AS n FROM workflow_run_steps WHERE run_id = $1', [runId])).rows[0].n as number;
    await persistSteps(c, runId, last + 1, out.records);
    // A call passed to a person gets its ticket in the same step that passed it, so none can be missed.
    await recordStepDecisions(c, { tenantId: ctx.run.tenant_id, callId: ctx.run.call_id ?? null, runId, records: out.records });
    await logLearningTurns(c, { tenantId: ctx.run.tenant_id, runId, callId: ctx.run.call_id ?? null, kind: ctx.run.kind, records: out.records, vars: out.state.vars, sensitive: out.state.sensitive, context: contextOf(out.state) });
    if (out.state.escalation || out.state.outcome === 'handoff_human') await ticketForEscalation(c, null, runId);
    return view(runId, out.state, out.records, ctx.run.state_version + 1);
  });
}

/**
 * End calls that were left waiting (the caller hung up, or a reply was claimed and the server stopped) so that
 * nothing sensitive stays held for a call that is never coming back.
 */
export async function abandonStaleRuns(d: RunDeps, actorId: string | null, e: { olderThanMinutes: number }) {
  return asInternal(d, async (c) => {
    const rows = (await c.query(
      `SELECT id, state FROM workflow_runs
        WHERE status IN ('running', 'awaiting_reply', 'processing') AND updated_at < now() - make_interval(mins => $1)
        ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED`, [e.olderThanMinutes])).rows;
    for (const r of rows) {
      const state = r.state as RunState;
      const ended: RunState = { ...state, status: 'ended', outcome: 'abandoned', node: null, awaiting: undefined, vars: Object.fromEntries(Object.entries(state.vars).filter(([k]) => !state.sensitive.includes(k))) };
      await c.query(
        `UPDATE workflow_runs SET state = $2, sealed = NULL, status = 'ended', outcome = 'abandoned', claimed_at = NULL, ended_at = now(), updated_at = now(), state_version = state_version + 1 WHERE id = $1`,
        [r.id, JSON.stringify(ended)]);
      const last = (await c.query('SELECT coalesce(max(seq), 0) AS n FROM workflow_run_steps WHERE run_id = $1', [r.id])).rows[0].n as number;
      await persistSteps(c, r.id, last + 1, [{ type: 'end', workflow: state.workflow, payload: { outcome: 'abandoned' } }]);
    }
    if (rows.length) await audit(c, actorId, 'workflow.runs_abandoned', 'workflow_run', null, { count: rows.length });
    return { abandoned: rows.length };
  });
}

export async function getRun(c: pg.PoolClient, runId: string) {
  const run = (await c.query(
    `SELECT id, tenant_id, workflow_id, version_id, environment, kind, batch_id, pins, status, outcome, error, started_at, ended_at, state
       FROM workflow_runs WHERE id = $1`, [runId])).rows[0];
  if (!run) throw new AppError(404, 'Run not found.');
  const steps = (await c.query('SELECT seq, type, workflow, node, payload, created_at, occurred_at FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq', [runId])).rows;
  return { ...run, variables: (run.state as RunState).vars, state: undefined, speech: speechOf(steps), steps };
}

export const listRuns = async (c: pg.PoolClient, workflowId: string, limit = 50) =>
  (await c.query(
    `SELECT r.id, r.environment, r.kind, r.status, r.outcome, r.error, r.started_at, v.major || '.' || v.minor AS version
       FROM workflow_runs r JOIN workflow_versions v ON v.id = r.version_id WHERE r.workflow_id = $1 ORDER BY r.started_at DESC LIMIT $2`, [workflowId, limit])).rows;

interface Played { scenario: Scenario; state: RunState; records: StepRecord[]; unused: number }

/** Play one scripted caller through the pinned workflows. Nothing is stored and no real system is touched. */
async function playScenario(resolved: Resolved, s: Scenario, speaker: Deps['speaker'], recordings: Deps['recordings'], journey?: Deps['journey']): Promise<Played> {
  // Rehearsals read the caller the way live calls do, so a scenario that angers the caller escalates in staging too.
  const deps: Deps = { load: (n) => resolved.defs[n], integrations: cannedIntegrations(s.integrations), speaker, recordings, journey };
  try {
    let { state, records } = await engineStart(resolved.entryName, s.variables, deps);
    const all = [...records]; const replies = [...(s.replies ?? [])];
    while (state.status === 'awaiting_reply' && replies.length) {
      const r = await engineReply(state, replies.shift()!, deps);
      state = r.state; all.push(...r.records);
    }
    return { scenario: s, state, records: all, unused: replies.length };
  } catch (err) {
    if (!(err instanceof PhoneInVariable)) throw err;
    // A scenario that carries a phone number is a failed scenario, not a failed simulation.
    const state: RunState = { workflow: resolved.entryName, node: null, vars: {}, stack: [], status: 'ended', outcome: 'error', error: err.message, steps: 0, sensitive: [] };
    return { scenario: s, state, records: [{ type: 'error', workflow: resolved.entryName, payload: { message: err.message } }], unused: 0 };
  }
}

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
    return { wf, resolved: await resolvePins(c, wf, 'staging', e.versionId), recordings: await recordingIndex(c, wf.tenant_id), journey: await getJourneyConfig(c, wf.tenant_id) };
  });

  const runs: Played[] = [];
  for (const s of e.scenarios) runs.push(await playScenario(ctx.resolved, s, d.speaker, ctx.recordings, ctx.journey));

  return asInternal(d, async (c) => {
    const results: ScenarioResult[] = runs.map((r) => evaluateScenario(r.scenario, { state: r.state, records: r.records, unusedReplies: r.unused }));
    // Run ids are chosen first so the batch, which can never be edited, is written once with its complete results.
    const ids = runs.map(() => randomUUID());
    results.forEach((r, i) => { r.runId = ids[i]; });
    const passed = results.filter((r) => r.passed).length;
    const problems = gateProblems(e.scenarios);
    const batch = (await c.query(
      `INSERT INTO simulation_batches (workflow_id, version_id, total, passed, failed, results, gate_ok, pins, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [ctx.wf.id, ctx.resolved.entryVersionId, results.length, passed, results.length - passed, JSON.stringify(results), problems.length === 0, JSON.stringify(ctx.resolved.pins), actorId])).rows[0];
    for (const [i, r] of runs.entries()) {
      const held = seal({ ...r.state, status: 'ended' }, d.key, ids[i]!); // a simulation is over once its script is spent: it keeps nothing sensitive
      await c.query(
        `INSERT INTO workflow_runs (id, tenant_id, workflow_id, version_id, environment, kind, batch_id, pins, state, status, outcome, error, ended_at)
         VALUES ($1,$2,$3,$4,'staging','simulation',$5,$6,$7,$8,$9,$10, now())`,
        [ids[i], ctx.wf.tenant_id, ctx.wf.id, ctx.resolved.entryVersionId, batch.id, JSON.stringify(ctx.resolved.pins), JSON.stringify({ ...held.state, status: r.state.status }), r.state.status, r.state.outcome ?? null, r.state.error ?? null]);
      await persistSteps(c, ids[i]!, 1, r.records);
    }
    return { batchId: batch.id as string, versionId: ctx.resolved.entryVersionId, total: results.length, passed, failed: results.length - passed, clean: passed === results.length && problems.length === 0, gateProblems: problems, pins: ctx.resolved.pins, results };
  });
}

const sumSpeech = (played: Played[]) => played.reduce((t, p) => {
  const s = speechOf(p.records);
  return { synthChars: t.synthChars + s.synthChars, recordedChars: t.recordedChars + s.recordedChars };
}, { synthChars: 0, recordedChars: 0 });

/**
 * What stitching saves on this version, measured by playing the same scripted callers twice: once with the client's
 * recordings and once with none (every line spoken live). The difference in synthesised characters is priced at the
 * voice provider's rate in force, exactly. Nothing is stored and no real system is touched.
 */
export async function measureStitching(d: RunDeps, e: { workflowId: string; versionId?: string; scenarios: Scenario[]; voiceProviderId: string; at?: Date }) {
  if (e.scenarios.length === 0) throw new AppError(400, 'Give at least one scenario.');
  if (e.scenarios.length > MAX_SCENARIOS) throw new AppError(400, `At most ${MAX_SCENARIOS} scenarios.`);
  const at = e.at ?? new Date();
  const ctx = await asInternal(d, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    const provider = (await c.query('SELECT id, kind, name FROM providers WHERE id = $1', [e.voiceProviderId])).rows[0];
    if (!provider || provider.kind !== 'voice') throw new AppError(400, 'Pick a voice provider: its character rate prices the difference.');
    const version = await chargingAt(c, e.voiceProviderId, at);
    if (!version) throw new AppError(409, `${provider.name} has no charging version in force. Capture its rates first.`);
    const lines = version.components.filter((k: { component: string; unit: string }) => k.component === 'tts' && ['per_character', 'per_1k_characters'].includes(k.unit));
    if (lines.length === 0) throw new AppError(409, `${provider.name} has no per-character speech rate, so the saving cannot be priced.`);
    const confirmed = Boolean(version.confirmed);
    const perUsds = new Map<string, bigint>();
    for (const k of lines) perUsds.set(k.currency, await perUsd(c, k.currency, at));
    return { wf, resolved: await resolvePins(c, wf, 'staging', e.versionId), recordings: await recordingIndex(c, wf.tenant_id), journey: await getJourneyConfig(c, wf.tenant_id), lines, perUsds, confirmed };
  });
  // One at a time, and with no model writing lines: a model's wording varies, and would colour the difference being measured
  // (a dynamic line speaks its fallback text here, and is live in both runs).
  const play = async (recordings: Deps['recordings']) => {
    const played: Played[] = [];
    for (const s of e.scenarios) played.push(await playScenario(ctx.resolved, s, undefined, recordings, ctx.journey));
    return sumSpeech(played);
  };
  const stitched = await play(ctx.recordings);
  const unstitched = await play(undefined);

  const costUsd = (chars: number): bigint => ctx.lines.reduce((sum: bigint, k: { unit: Unit; rate: string; currency: string; billing_line: string }) => {
    const q = quantityFor(k.unit, k.billing_line, { characters: chars }, null);
    return q ? sum + mulDiv(lineAmount(k.rate, q), SCALE, ctx.perUsds.get(k.currency)!) : sum;
  }, 0n);
  const before = costUsd(unstitched.synthChars); const after = costUsd(stitched.synthChars);
  const savedBp = before > 0n ? mulDiv(before - after, 10_000n, before) : 0n;
  return {
    scenarios: e.scenarios.length,
    unstitched: { synthChars: unstitched.synthChars, costUsd: fromScaled(before) },
    stitched: { synthChars: stitched.synthChars, recordedChars: stitched.recordedChars, costUsd: fromScaled(after) },
    saved: { chars: unstitched.synthChars - stitched.synthChars, costUsd: fromScaled(before - after), percent: (Number(savedBp) / 100).toFixed(2) },
    ratesConfirmed: ctx.confirmed,
    note: 'Measured on the scripted callers given, at the voice provider\'s rate in force. It prices synthesis only (not telephony), and says nothing about how the call sounds.',
  };
}

export interface HandoverPacket {
  workflow: string; node: string | null; status: string;
  /** Everything collected so far. Sensitive variables are never part of it. */
  variables: Record<string, Json>;
  transcript: { role: 'assistant' | 'caller'; text: string }[];
  /** The last thing the call said in full, which the new provider replays if it was cut off. */
  lastLine: string | null;
}

/**
 * What a provider that takes over a call in progress needs: where the flow is, what has been collected, and what
 * was said by each side. A sensitive answer was recorded as hidden, and sensitive values are not in the state.
 */
export async function handoverPacket(c: pg.PoolClient, runId: string): Promise<HandoverPacket> {
  const run = await getRun(c, runId);
  const state = (await c.query('SELECT state FROM workflow_runs WHERE id = $1', [runId])).rows[0].state as RunState;
  const transcript = (run.steps as { type: string; payload: Record<string, Json> }[])
    .filter((s) => s.type === 'say' || s.type === 'heard')
    .map((s) => ({ role: s.type === 'say' ? 'assistant' as const : 'caller' as const, text: String(s.payload.text ?? '') }));
  const lastLine = [...transcript].reverse().find((t) => t.role === 'assistant')?.text ?? null;
  return { workflow: state.workflow, node: state.node ?? state.awaiting?.node ?? null, status: state.status, variables: state.vars, transcript, lastLine };
}

/** What a voice provider charges for speech at a time, as a function from characters to USD (exact). */
export async function ttsPricing(c: pg.PoolClient, voiceProviderId: string, at: Date) {
  const provider = (await c.query('SELECT id, kind, name FROM providers WHERE id = $1', [voiceProviderId])).rows[0];
  if (!provider || provider.kind !== 'voice') throw new AppError(400, 'Pick a voice provider: its character rate prices the speech.');
  const version = await chargingAt(c, voiceProviderId, at);
  if (!version) throw new AppError(409, `${provider.name} has no charging version in force. Capture its rates first.`);
  const lines: { unit: Unit; rate: string; currency: string; billing_line: string }[] = version.components.filter((k: { component: string; unit: string }) => k.component === 'tts' && ['per_character', 'per_1k_characters'].includes(k.unit));
  if (lines.length === 0) throw new AppError(409, `${provider.name} has no per-character speech rate, so the speech cannot be priced.`);
  const perUsds = new Map<string, bigint>();
  for (const k of lines) perUsds.set(k.currency, await perUsd(c, k.currency, at));
  const price = (chars: number): bigint => lines.reduce((sum, k) => {
    const q = quantityFor(k.unit, k.billing_line, { characters: chars }, null);
    return q ? sum + mulDiv(lineAmount(k.rate, q), SCALE, perUsds.get(k.currency)!) : sum;
  }, 0n);
  return { price, confirmed: Boolean(version.confirmed) };
}

export interface VersionMeasure { versionId: string; synthChars: number; recordedChars: number; says: number; steps: number; escalations: number; outcomes: Record<string, number>; costUsd: string | null }

/**
 * Play the same scripted callers through several versions of a workflow and count what each does: how much is spoken
 * live, how many lines and steps, how many escalate, how the calls end. Optionally price the live speech at a voice
 * provider's rate. This is what a proposed change's financial assessment is built from. Nothing is stored.
 */
export async function measureVersions(d: RunDeps, e: { workflowId: string; versionIds: string[]; scenarios: Scenario[]; voiceProviderId?: string; at?: Date }): Promise<{ versions: VersionMeasure[]; ratesConfirmed: boolean | null }> {
  if (e.scenarios.length === 0) throw new AppError(400, 'Give at least one scenario.');
  if (e.scenarios.length > MAX_SCENARIOS) throw new AppError(400, `At most ${MAX_SCENARIOS} scenarios.`);
  const at = e.at ?? new Date();
  const ctx = await asInternal(d, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    let lines: { unit: Unit; rate: string; currency: string; billing_line: string }[] = []; const perUsds = new Map<string, bigint>(); let confirmed: boolean | null = null;
    if (e.voiceProviderId) {
      const provider = (await c.query('SELECT id, kind, name FROM providers WHERE id = $1', [e.voiceProviderId])).rows[0];
      if (!provider || provider.kind !== 'voice') throw new AppError(400, 'Pick a voice provider: its character rate prices the speech.');
      const version = await chargingAt(c, e.voiceProviderId, at);
      if (!version) throw new AppError(409, `${provider.name} has no charging version in force. Capture its rates first.`);
      lines = version.components.filter((k: { component: string; unit: string }) => k.component === 'tts' && ['per_character', 'per_1k_characters'].includes(k.unit));
      if (lines.length === 0) throw new AppError(409, `${provider.name} has no per-character speech rate, so the speech cannot be priced.`);
      confirmed = Boolean(version.confirmed);
      for (const k of lines) perUsds.set(k.currency, await perUsd(c, k.currency, at));
    }
    const resolved = [];
    for (const vid of e.versionIds) resolved.push(await resolvePins(c, wf, 'staging', vid));
    return { resolved, recordings: await recordingIndex(c, wf.tenant_id), journey: await getJourneyConfig(c, wf.tenant_id), lines, perUsds, confirmed };
  });
  const price = (chars: number): bigint => ctx.lines.reduce((sum, k) => {
    const q = quantityFor(k.unit, k.billing_line, { characters: chars }, null);
    return q ? sum + mulDiv(lineAmount(k.rate, q), SCALE, ctx.perUsds.get(k.currency)!) : sum;
  }, 0n);
  const versions: VersionMeasure[] = [];
  for (const [i, resolved] of ctx.resolved.entries()) {
    const played: Played[] = [];
    for (const s of e.scenarios) played.push(await playScenario(resolved, s, undefined, ctx.recordings, ctx.journey));
    const sp = sumSpeech(played);
    const outcomes: Record<string, number> = {};
    for (const p of played) { const o = p.state.outcome ?? p.state.status; outcomes[o] = (outcomes[o] ?? 0) + 1; }
    versions.push({
      versionId: e.versionIds[i]!, synthChars: sp.synthChars, recordedChars: sp.recordedChars,
      says: played.reduce((n, p) => n + p.records.filter((r) => r.type === 'say').length, 0), steps: played.reduce((n, p) => n + p.records.length, 0),
      escalations: played.filter((p) => p.state.escalation).length, outcomes, costUsd: e.voiceProviderId ? fromScaled(price(sp.synthChars)) : null,
    });
  }
  return { versions, ratesConfirmed: ctx.confirmed };
}
