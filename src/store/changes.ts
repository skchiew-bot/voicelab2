import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { diffDefinitions } from '../journey/diff.js';
import { fromScaled, toScaled } from '../money.js';
import { framesOf } from '../workflows/stitch.js';
import type { Json, WorkflowDefinition } from '../workflows/definition.js';
import type { Scenario } from '../workflows/simulate.js';
import { audit } from './audit.js';
import { recordingIndex } from './recordings.js';
import { measureVersions, type RunDeps, type VersionMeasure } from './runs.js';
import { deploy, getVersion, getWorkflow, liveVersionId, type Environment } from './workflows.js';

/** How many levels of approval a client's process changes need, in order. With nothing set there is one. */
export async function setApprovalPolicy(c: pg.PoolClient, actorId: string | null, tenantId: string, levels: string[]) {
  if (levels.length < 1 || levels.length > 5 || levels.some((l) => !l.trim() || l.length > 80)) throw new AppError(400, 'Give between one and five levels, each with a name.');
  await c.query(
    `INSERT INTO approval_policies (tenant_id, levels) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET levels = $2, updated_at = now()`,
    [tenantId, JSON.stringify(levels.map((name) => ({ name: name.trim() })))]);
  await audit(c, actorId, 'approval.policy', 'tenant', tenantId, { levels: levels.length });
  return getApprovalPolicy(c, tenantId);
}
export async function getApprovalPolicy(c: pg.PoolClient, tenantId: string): Promise<{ name: string }[]> {
  const r = (await c.query('SELECT levels FROM approval_policies WHERE tenant_id = $1', [tenantId])).rows[0];
  return r ? r.levels : [{ name: 'Approver' }];
}

export interface Assessment {
  basis: { scenarios: number };
  before: VersionMeasure | null; after: VersionMeasure;
  delta: { synthChars: number; says: number; steps: number; escalations: number; costUsd: string | null };
  ratesConfirmed: boolean | null;
  note: string;
}

/** Turn two measurements into the assessment attached to a change. Money is exact; the rest is counts. */
export function assess(before: VersionMeasure | null, after: VersionMeasure, scenarios: number, ratesConfirmed: boolean | null): Assessment {
  const cost = after.costUsd === null ? null : fromScaled(toScaled(after.costUsd) - toScaled(before?.costUsd ?? '0'));
  return {
    basis: { scenarios }, before, after,
    delta: { synthChars: after.synthChars - (before?.synthChars ?? 0), says: after.says - (before?.says ?? 0), steps: after.steps - (before?.steps ?? 0), escalations: after.escalations - (before?.escalations ?? 0), costUsd: cost },
    ratesConfirmed,
    note: `Measured on ${scenarios} scripted caller${scenarios === 1 ? '' : 's'} played through both versions. It counts speech spoken live${after.costUsd === null ? ' (no voice provider was given, so it is not priced)' : ' and prices it at the voice provider\'s rate'}; call length and telephony cost are not estimated.`,
  };
}

/**
 * Propose putting a version live. The proposal records the version live now (what it replaces), why, the approvals it
 * needs, and a financial assessment worked out by playing the same scripted callers through both versions.
 */
export async function requestChange(
  d: RunDeps, actorId: string | null,
  e: { workflowId: string; toVersionId: string; environment: Environment; reason: string; scenarios: Scenario[]; voiceProviderId?: string },
) {
  if (!e.reason.trim()) throw new AppError(400, 'Say why the change is wanted.');
  if (e.scenarios.length === 0) throw new AppError(400, 'Give at least one scenario: every change carries a financial assessment.');
  const head = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const wf = await getWorkflow(c, e.workflowId);
    const to = await getVersion(c, e.toVersionId);
    if (to.workflow_id !== e.workflowId) throw new AppError(404, 'That version does not belong to this workflow.');
    if (!to.valid) throw new AppError(400, 'That version has errors and cannot be proposed.');
    const fromId = (await liveVersionId(c, e.workflowId, e.environment)) ?? null;
    if (fromId === to.id) throw new AppError(409, 'That version is already live there.');
    const from = fromId ? await getVersion(c, fromId) : null;
    return { wf, to, from, levels: await getApprovalPolicy(c, wf.tenant_id) };
  });
  const m = await measureVersions(d, { workflowId: e.workflowId, versionIds: [...(head.from ? [head.from.id as string] : []), head.to.id as string], scenarios: e.scenarios, voiceProviderId: e.voiceProviderId });
  const financial = assess(head.from ? m.versions[0]! : null, m.versions[m.versions.length - 1]!, e.scenarios.length, m.ratesConfirmed);
  return withActor(d.pool, { kind: 'internal' }, async (c) => {
    const row = (await c.query(
      `INSERT INTO change_requests (tenant_id, workflow_id, environment, from_version_id, to_version_id, reason, levels, financial, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [head.wf.tenant_id, e.workflowId, e.environment, head.from?.id ?? null, head.to.id, e.reason.trim(), JSON.stringify(head.levels), JSON.stringify(financial), actorId])).rows[0];
    await audit(c, actorId, 'change.request', 'workflow', e.workflowId, { change: row.id, to: `${head.to.major}.${head.to.minor}`, environment: e.environment });
    return getChange(c, row.id as string);
  });
}

type Status = 'pending' | 'approved' | 'rejected' | 'applied';

export async function getChange(c: pg.PoolClient, id: string) {
  const r = (await c.query(
    `SELECT cr.*, w.name AS workflow, vf.major || '.' || vf.minor AS from_version, vt.major || '.' || vt.minor AS to_version,
            vf.definition AS from_definition, vt.definition AS to_definition
       FROM change_requests cr JOIN workflows w ON w.id = cr.workflow_id LEFT JOIN workflow_versions vf ON vf.id = cr.from_version_id JOIN workflow_versions vt ON vt.id = cr.to_version_id
      WHERE cr.id = $1`, [id])).rows[0];
  if (!r) throw new AppError(404, 'Change not found.');
  const approvals = (await c.query('SELECT level, decision, note, decided_by, at FROM change_approvals WHERE change_id = $1 ORDER BY level', [id])).rows;
  const applied = (await c.query('SELECT deployment_id, applied_by, at FROM change_applications WHERE change_id = $1', [id])).rows[0] ?? null;
  const levels = r.levels as { name: string }[];
  const rejected = approvals.some((a) => a.decision === 'rejected');
  const status: Status = applied ? 'applied' : rejected ? 'rejected' : approvals.length >= levels.length ? 'approved' : 'pending';
  const diff = diffDefinitions(r.from_definition as WorkflowDefinition | null, r.to_definition as WorkflowDefinition);
  const { from_definition, to_definition, ...rest } = r;
  void from_definition; void to_definition;
  return {
    ...rest, status, diff, applied,
    progress: levels.map((l, i) => ({ level: i, name: l.name, decision: approvals.find((a) => a.level === i)?.decision ?? null, note: approvals.find((a) => a.level === i)?.note ?? null, decided_by: approvals.find((a) => a.level === i)?.decided_by ?? null, at: approvals.find((a) => a.level === i)?.at ?? null })),
    nextLevel: status === 'pending' ? approvals.length : null,
  };
}

export const listChanges = async (c: pg.PoolClient, o: { tenantId?: string; workflowId?: string; limit?: number }) => {
  const ids = (await c.query(
    `SELECT id FROM change_requests WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::uuid IS NULL OR workflow_id = $2) ORDER BY created_at DESC LIMIT $3`,
    [o.tenantId ?? null, o.workflowId ?? null, o.limit ?? 50])).rows;
  const out = [];
  for (const { id } of ids) { const { diff, financial, progress, ...rest } = await getChange(c, id); out.push({ ...rest, changes: diff.summary.length, delta: (financial as Assessment).delta, levelsDone: progress.filter((p: { decision: string | null }) => p.decision === 'approved').length, levelsTotal: progress.length }); }
  return out;
};

/**
 * One level decides. Levels go in order, a person decides at most one level of a change, and nobody approves what they
 * proposed. A rejection ends it. Every decision is kept for good.
 */
export async function decide(c: pg.PoolClient, actorId: string, changeId: string, e: { decision: 'approved' | 'rejected'; note?: string }) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`change:${changeId}`]);
  const ch = await getChange(c, changeId);
  if (ch.status !== 'pending') throw new AppError(409, `This change is ${ch.status}; it can no longer be decided.`);
  await assertStillCurrent(c, ch);
  if (ch.requested_by === actorId) throw new AppError(403, 'You proposed this change, so you cannot decide it.');
  const prior = (await c.query('SELECT 1 FROM change_approvals WHERE change_id = $1 AND decided_by = $2', [changeId, actorId])).rowCount;
  if (prior) throw new AppError(403, 'You have already decided a level of this change. Each level needs someone else.');
  if (e.decision === 'rejected' && !e.note?.trim()) throw new AppError(400, 'Say why you are turning this down.');
  await c.query('INSERT INTO change_approvals (change_id, level, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5)', [changeId, ch.nextLevel, e.decision, e.note ?? null, actorId]);
  await audit(c, actorId, 'change.decide', 'change', changeId, { level: ch.nextLevel, decision: e.decision });
  return getChange(c, changeId);
}

/** The flow must still be at the version the change was written against; otherwise approvers saw a diff that is out of date. */
async function assertStillCurrent(c: pg.PoolClient, ch: { workflow_id: string; environment: Environment; from_version_id: string | null }) {
  const live = (await liveVersionId(c, ch.workflow_id, ch.environment)) ?? null;
  if (live !== ch.from_version_id) throw new AppError(409, 'The live flow has changed since this change was proposed, so what was reviewed is out of date. Propose it again against the current version.');
}

/** Put an approved change live, by the same gates as any other deploy. Once only. */
export async function applyChange(c: pg.PoolClient, actorId: string, changeId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`change:${changeId}`]);
  const ch = await getChange(c, changeId);
  if (ch.status === 'applied') throw new AppError(409, 'This change has already been applied.');
  if (ch.status !== 'approved') throw new AppError(409, `This change is ${ch.status}. It needs every level approved before it can go live.`);
  // Changes to one flow go live one at a time, and only against the version they were written for.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`change-live:${ch.workflow_id}:${ch.environment}`]);
  await assertStillCurrent(c, ch);
  const dep = await deploy(c, actorId, ch.workflow_id, { versionId: ch.to_version_id, environment: ch.environment });
  await c.query('INSERT INTO change_applications (change_id, deployment_id, applied_by) VALUES ($1,$2,$3)', [changeId, dep.id, actorId]);
  await audit(c, actorId, 'change.apply', 'change', changeId, { environment: ch.environment, version: ch.to_version });
  return getChange(c, changeId);
}

/**
 * The client-facing story of a change: the flow as it is, what was detected in it, what is changing and why, and the
 * flow after, with the audio that could be played. "Detected" is what the live and test calls on the current version
 * actually showed in the last 30 days.
 *
 * Internal only: `financial` is provider cost, `recordingId` points at internal recordings and `approvals` name staff. A
 * view served to a client must be cut down from this, never passed through.
 */
export async function showcase(c: pg.PoolClient, changeId: string) {
  const ch = await getChange(c, changeId);
  const defs = (await c.query('SELECT id, definition FROM workflow_versions WHERE id = ANY($1::uuid[])', [[ch.from_version_id, ch.to_version_id].filter(Boolean)])).rows;
  const byId = new Map(defs.map((r) => [r.id as string, r.definition as WorkflowDefinition]));
  const outline = (def: WorkflowDefinition | undefined) => def ? Object.entries(def.nodes).map(([id, n]) => ({ id, type: n.type, start: id === def.start, text: framesOf({ nodes: { [id]: n as never } }).map((f) => f.text).join(' … ') || ((n as { prompt?: string; outcome?: string }).prompt ?? (n as { outcome?: string }).outcome ?? '') })) : [];

  const base = ch.from_version_id as string | null;
  const det = base ? (await c.query(
    `SELECT count(*)::int AS calls,
            count(*) FILTER (WHERE r.state ? 'escalation')::int AS escalated,
            count(*) FILTER (WHERE r.status = 'ended' AND r.outcome IN ('error', 'integration_failed'))::int AS failed
       FROM workflow_runs r WHERE r.version_id = $1 AND r.kind IN ('live', 'test') AND r.started_at > now() - interval '30 days'`, [base])).rows[0] : { calls: 0, escalated: 0, failed: 0 };
  const mood = base ? (await c.query(
    `SELECT round(avg((s.payload->'analysis'->>'sentiment')::numeric), 2) AS avg, count(*)::int AS turns,
            count(*) FILTER (WHERE (s.payload->'analysis'->>'understood') = 'false')::int AS not_understood
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE r.version_id = $1 AND r.kind IN ('live', 'test') AND r.started_at > now() - interval '30 days' AND s.type = 'heard' AND s.payload ? 'analysis'`, [base])).rows[0] : { avg: null, turns: 0, not_understood: 0 };
  const worst = base ? (await c.query(
    `SELECT r.state->'escalation'->>'node' AS node, count(*)::int AS escalations FROM workflow_runs r
      WHERE r.version_id = $1 AND r.kind IN ('live', 'test') AND r.started_at > now() - interval '30 days' AND r.state ? 'escalation' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [base])).rows : [];

  const idx = await recordingIndex(c, ch.tenant_id);
  const audio = framesOf((byId.get(ch.to_version_id) ?? { nodes: {} }) as never).map((f) => ({ node: f.node, language: f.language, text: f.text, recordingId: idx.find(f.language, f.text)?.id ?? null }));
  return {
    change: { id: ch.id, workflow: ch.workflow, environment: ch.environment, status: ch.status, reason: ch.reason, from: ch.from_version, to: ch.to_version },
    before: { version: ch.from_version, steps: outline(base ? byId.get(base) : undefined) },
    detected: {
      periodDays: 30, calls: det.calls, escalated: det.escalated, escalationPercent: det.calls ? Math.round((det.escalated / det.calls) * 1000) / 10 : null, failed: det.failed,
      averageSentiment: mood.avg === null ? null : Number(mood.avg), turns: mood.turns, turnsNotUnderstood: mood.not_understood, whereCallsEscalate: worst,
    },
    why: ch.reason,
    changes: ch.diff,
    after: { version: ch.to_version, steps: outline(byId.get(ch.to_version_id)) },
    financial: ch.financial as Json,
    approvals: ch.progress,
    audio,
    audioNote: audio.length === 0 ? 'The new version has no fixed words to play.' : `${audio.filter((a) => a.recordingId).length} of ${audio.length} fixed phrases have a recording to play; the rest are spoken live.`,
  };
}
