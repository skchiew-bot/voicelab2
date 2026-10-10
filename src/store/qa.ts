import type pg from 'pg';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { parseCriteria } from '../journey/qa-schema.js';
import { scoreCall, type Criterion, type Judge } from '../journey/qa.js';
import { audit } from './audit.js';
import { modelFor, recordDecision, type Tier } from './ai-decisions.js';
import { replayRun } from './replay.js';

export interface QaDeps { pool: pg.Pool; judges?: Partial<Record<'haiku' | 'sonnet' | 'opus', Judge>> }

/** A client's QA criteria for a use case (a workflow's name, or "*" for every workflow). A change is a new version. */
export async function addCriteriaSet(c: pg.PoolClient, actorId: string | null, tenantId: string, useCase: string, input: unknown) {
  let criteria: Criterion[];
  try { criteria = parseCriteria(input); } catch (e) { throw new AppError(400, 'The criteria are not valid.', ((e as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`)); }
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`qa:${tenantId}:${useCase}`]);
  const version = ((await c.query('SELECT coalesce(max(version), 0) AS v FROM qa_criteria_sets WHERE tenant_id = $1 AND use_case = $2', [tenantId, useCase])).rows[0].v as number) + 1;
  const row = (await c.query(
    'INSERT INTO qa_criteria_sets (tenant_id, use_case, version, criteria, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, tenant_id, use_case, version, criteria, created_at',
    [tenantId, useCase, version, JSON.stringify(criteria), actorId])).rows[0];
  await audit(c, actorId, 'qa.criteria', 'tenant', tenantId, { useCase, version, count: criteria.length });
  return row;
}

export const listCriteriaSets = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(
    `SELECT DISTINCT ON (use_case) id, use_case, version, criteria, created_at FROM qa_criteria_sets WHERE tenant_id = $1 ORDER BY use_case, version DESC`, [tenantId])).rows;

/**
 * Score the finished calls that have not been scored yet, a batch at a time. The criteria used for a call are the latest
 * for its workflow, else the client's "*" set. A call with no criteria is left alone. The model that judges is the one
 * configured for the task (and the tier above it for doubtful answers); with none configured, only the rules are applied.
 */
export async function scoreBatch(d: QaDeps, actorId: string | null, e: { tenantId: string; limit?: number }) {
  const limit = Math.min(e.limit ?? 50, 500);
  const plan = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const runs = (await c.query(
      `SELECT r.id, r.call_id, w.name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
        WHERE r.tenant_id = $1 AND r.kind IN ('live', 'test') AND r.status = 'ended'
          AND NOT EXISTS (SELECT 1 FROM qa_scores q WHERE q.run_id = r.id) ORDER BY r.ended_at LIMIT $2`, [e.tenantId, limit])).rows;
    const sets = new Map((await listCriteriaSets(c, e.tenantId)).map((s) => [s.use_case as string, s]));
    const cfg = await modelFor(c, 'qa_judge');
    return { runs, sets, cfg };
  });
  const primary = plan.cfg ? d.judges?.[plan.cfg.tier] : undefined;
  const escalate = plan.cfg?.escalateTo ? d.judges?.[plan.cfg.escalateTo] : undefined;
  let scored = 0; let skipped = 0;
  for (const run of plan.runs) {
    const set = plan.sets.get(run.name) ?? plan.sets.get('*');
    if (!set) { skipped++; continue; }
    // Judging can take a while: the replay is built in one short transaction and the model is asked outside it.
    const rp = await withActor(d.pool, { kind: 'internal' }, (c) => replayRun(c, run.id));
    const card = await scoreCall(set.criteria as Criterion[], rp, { primary, escalate });
    await withActor(d.pool, { kind: 'internal' }, async (c) => {
      const used = card.usage.length ? card.usage[card.usage.length - 1]! : null;
      const row = await c.query(
        `INSERT INTO qa_scores (tenant_id, run_id, call_id, criteria_set_id, score, results, scorer, model, tier, input_tokens, output_tokens, escalated_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (run_id, criteria_set_id) DO NOTHING RETURNING id`,
        [e.tenantId, run.id, run.call_id, set.id, card.score ?? 0, JSON.stringify({ complete: card.complete, results: card.results }), card.usage.length ? 'model+rules' : 'rules',
          used?.model ?? null, used?.tier ?? null, card.usage.reduce((s, u) => s + u.inputTokens, 0), card.usage.reduce((s, u) => s + u.outputTokens, 0), card.usage.find((u) => u.escalatedFrom)?.escalatedFrom ?? null]);
      if (!row.rowCount) return;
      // Every model judgement, and every step up a tier, goes in the audit trail with its tokens.
      for (const u of card.usage) {
        await recordDecision(c, {
          tenantId: e.tenantId, task: 'qa_judge', subjectType: 'qa_criterion', subjectId: `${run.id}:${u.criterion}`, callId: run.call_id,
          decision: u.passed ? 'proceeded' : 'rejected', reason: u.reason || 'No reason given.', model: u.model, tier: u.tier as Tier,
          inputTokens: u.inputTokens, outputTokens: u.outputTokens, confidence: u.confidence, escalatedFrom: u.escalatedFrom,
        });
      }
      await recordDecision(c, {
        tenantId: e.tenantId, task: 'qa_score', subjectType: 'run', subjectId: run.id, callId: run.call_id, decision: 'proceeded',
        reason: `Scored ${card.score ?? 'n/a'} against ${set.use_case} v${set.version}${card.complete ? '' : ' (some criteria not scored: no model)'}.`, tier: 'rules',
      });
    });
    scored++;
  }
  if (scored) await withActor(d.pool, { kind: 'internal' }, (c) => audit(c, actorId, 'qa.score_batch', 'tenant', e.tenantId, { scored, skipped }));
  return { scored, skipped, remaining: Math.max(0, plan.runs.length - scored - skipped), usedModel: Boolean(primary) };
}

export const listScores = async (c: pg.PoolClient, o: { tenantId?: string; runId?: string; limit?: number }) =>
  (await c.query(
    `SELECT s.id, s.tenant_id, s.run_id, s.call_id, s.score, s.results, s.scorer, s.model, s.tier, s.input_tokens, s.output_tokens, s.escalated_from, s.created_at,
            cs.use_case, cs.version AS criteria_version, w.name AS workflow
       FROM qa_scores s JOIN qa_criteria_sets cs ON cs.id = s.criteria_set_id JOIN workflow_runs r ON r.id = s.run_id JOIN workflows w ON w.id = r.workflow_id
      WHERE ($1::uuid IS NULL OR s.tenant_id = $1) AND ($2::uuid IS NULL OR s.run_id = $2) ORDER BY s.created_at DESC LIMIT $3`,
    [o.tenantId ?? null, o.runId ?? null, o.limit ?? 50])).rows;

export async function qaSummary(c: pg.PoolClient, tenantId: string) {
  const byWorkflow = (await c.query(
    `SELECT w.name AS workflow, count(*)::int AS scored, round(avg(s.score), 2) AS average, min(s.score) AS lowest
       FROM qa_scores s JOIN workflow_runs r ON r.id = s.run_id JOIN workflows w ON w.id = r.workflow_id WHERE s.tenant_id = $1 GROUP BY w.name ORDER BY w.name`, [tenantId])).rows;
  const failing = (await c.query(
    `SELECT x->>'id' AS criterion, x->>'label' AS label, count(*)::int AS failed
       FROM qa_scores s, jsonb_array_elements(s.results->'results') x WHERE s.tenant_id = $1 AND (x->>'passed') = 'false' GROUP BY 1, 2 ORDER BY failed DESC LIMIT 10`, [tenantId])).rows;
  const unscored = (await c.query(
    `SELECT count(*)::int AS n FROM workflow_runs r WHERE r.tenant_id = $1 AND r.kind IN ('live', 'test') AND r.status = 'ended' AND NOT EXISTS (SELECT 1 FROM qa_scores q WHERE q.run_id = r.id)`, [tenantId])).rows[0].n as number;
  return { byWorkflow, mostFailed: failing, unscored };
}
