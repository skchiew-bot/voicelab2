import type pg from 'pg';
import { AppError } from '../errors.js';
import type { Json } from '../workflows/definition.js';
import { audit } from './audit.js';

export type Decision = 'proceeded' | 'rejected' | 'reworked';
export type Tier = 'rules' | 'haiku' | 'sonnet' | 'opus';

export interface DecisionInput {
  tenantId?: string | null; task: string; subjectType: string; subjectId: string; decision: Decision; reason: string;
  model?: string | null; tier?: Tier | null; inputTokens?: number; outputTokens?: number; confidence?: number | null;
  escalatedFrom?: string | null; callId?: string | null;
}

/** One decision an AI made that mattered, and why it went ahead, was turned down, or was reworked. Never edited. */
export async function recordDecision(c: pg.PoolClient, d: DecisionInput) {
  if (!d.reason.trim()) throw new AppError(400, 'A decision needs a reason.');
  await c.query(
    `INSERT INTO ai_decisions (tenant_id, task, subject_type, subject_id, decision, reason, model, tier, input_tokens, output_tokens, confidence, escalated_from, call_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [d.tenantId ?? null, d.task, d.subjectType, d.subjectId, d.decision, d.reason.slice(0, 1000), d.model ?? null, d.tier ?? null, d.inputTokens ?? 0, d.outputTokens ?? 0, d.confidence ?? null, d.escalatedFrom ?? null, d.callId ?? null]);
}

// ------------------------------------------------------------------------------------- model configuration
export interface ModelChoice { taskKey: string; tier: 'haiku' | 'sonnet' | 'opus'; modelId: string; escalateTo: 'haiku' | 'sonnet' | 'opus' | null }

/** Which model does a task use? Configuration, not code: changing a row changes it without a deploy. */
export async function modelFor(c: pg.PoolClient, taskKey: string): Promise<ModelChoice | null> {
  const r = (await c.query('SELECT task_key, tier, model_id, escalate_to FROM model_config WHERE task_key = $1', [taskKey])).rows[0];
  return r ? { taskKey: r.task_key, tier: r.tier, modelId: r.model_id, escalateTo: r.escalate_to } : null;
}

export async function setModel(c: pg.PoolClient, actorId: string | null, m: ModelChoice) {
  const order = { haiku: 0, sonnet: 1, opus: 2 } as const;
  if (m.escalateTo && order[m.escalateTo] <= order[m.tier]) throw new AppError(400, 'A task escalates to a stronger tier than its own.');
  await c.query(
    `INSERT INTO model_config (task_key, tier, model_id, escalate_to) VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_key) DO UPDATE SET tier = $2, model_id = $3, escalate_to = $4, updated_at = now()`, [m.taskKey, m.tier, m.modelId, m.escalateTo]);
  await audit(c, actorId, 'model.set', 'model_config', m.taskKey, { tier: m.tier, escalateTo: m.escalateTo });
  return modelFor(c, m.taskKey);
}
export const listModels = async (c: pg.PoolClient) => (await c.query('SELECT task_key, tier, model_id, escalate_to, updated_at FROM model_config ORDER BY task_key')).rows;

/** The tier a model id is configured at, so a decision records how strong a model made it. */
async function tierOf(c: pg.PoolClient, model: string | null | undefined): Promise<Tier | null> {
  if (!model) return null;
  return ((await c.query('SELECT tier FROM model_config WHERE model_id = $1 LIMIT 1', [model])).rows[0]?.tier as Tier | undefined) ?? null;
}

/** The decisions recorded in a run's steps (a model's line that was used, tidied or turned down), put in the audit trail. */
export async function recordStepDecisions(
  c: pg.PoolClient, e: { tenantId: string; callId: string | null; runId: string; records: { type: string; node?: string; payload: Record<string, Json> }[] },
) {
  for (const r of e.records) {
    const ai = r.type === 'say' ? (r.payload.ai as Record<string, Json> | undefined) : undefined;
    if (!ai?.decision) continue;
    await recordDecision(c, {
      tenantId: e.tenantId, task: 'speak_dynamic', subjectType: 'run_step', subjectId: `${e.runId}:${r.node ?? ''}`, callId: e.callId,
      decision: ai.decision as Decision, reason: String(ai.decisionReason ?? ai.reasoning ?? 'No reason given.'),
      model: (ai.model as string | undefined) ?? null, tier: await tierOf(c, ai.model as string | undefined),
      inputTokens: Number(ai.inputTokens ?? 0), outputTokens: Number(ai.outputTokens ?? 0), confidence: ai.confidence === undefined ? null : Number(ai.confidence),
    });
  }
}

export const listDecisions = async (c: pg.PoolClient, o: { tenantId?: string; callId?: string; subjectType?: string; subjectId?: string; limit?: number }) =>
  (await c.query(
    `SELECT id, tenant_id, task, subject_type, subject_id, decision, reason, model, tier, input_tokens, output_tokens, confidence, escalated_from, call_id, at
       FROM ai_decisions WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::uuid IS NULL OR call_id = $2)
        AND ($3::text IS NULL OR subject_type = $3) AND ($4::text IS NULL OR subject_id = $4) ORDER BY id DESC LIMIT $5`,
    [o.tenantId ?? null, o.callId ?? null, o.subjectType ?? null, o.subjectId ?? null, o.limit ?? 100])).rows;

/** What the AI steps cost in tokens, by task and model: what the Control Tower rolls up. */
export const tokenUsage = async (c: pg.PoolClient, o: { tenantId?: string } = {}) =>
  (await c.query(
    `SELECT task, coalesce(model, 'rules') AS model, coalesce(tier, 'rules') AS tier, count(*)::int AS decisions,
            sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
            count(*) FILTER (WHERE decision = 'rejected')::int AS rejected, count(*) FILTER (WHERE decision = 'reworked')::int AS reworked,
            count(*) FILTER (WHERE escalated_from IS NOT NULL)::int AS escalations
       FROM ai_decisions WHERE ($1::uuid IS NULL OR tenant_id = $1) GROUP BY 1, 2, 3 ORDER BY 1, 2`, [o.tenantId ?? null])).rows;
