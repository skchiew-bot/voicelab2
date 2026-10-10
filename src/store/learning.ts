import type pg from 'pg';
import { z } from 'zod';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { checkScript, clusterTurns, fixedChars, nodeHash as hashNode, slotify, slotsIn, type Cluster } from '../learning/cluster.js';
import { SLOT_RE, type WorkflowDefinition } from '../workflows/definition.js';
import { normalizeSpoken } from '../workflows/stitch.js';
import { redactNumbers } from '../telephony/types.js';
import { audit } from './audit.js';
import { recordDecision, modelFor, type Tier } from './ai-decisions.js';
import { addRecording, recordingIndex, type ContentType } from './recordings.js';
import { ttsPricing } from './runs.js';
import { fromScaled } from '../money.js';

// ------------------------------------------------------------------------------------------------ the models behind it
export interface DistillInput { workflow: string; node: string; nodePrompt: string; slots: string[]; examples: { text: string; count: number }[]; avoid: string[] }
export interface Distilled { script: string; confidence: number; inputTokens: number; outputTokens: number }
/** Writes one canonical script, with the slots marked, from a cluster's wordings (per cluster, so a mid-size model). */
export interface Distiller { tier: 'haiku' | 'sonnet' | 'opus'; model: string; distill(i: DistillInput): Promise<Distilled> }

export interface ReviewInput { council: 'quality' | 'cx'; script: string; nodePrompt: string; support: number; variants: number; examples: string[]; checks: string[] }
export interface Review { pass: boolean; confidence: number; concerns: string[]; inputTokens: number; outputTokens: number }
/** A council reviews a script: Quality (is it correct and safe to say) or Customer Experience (does it sound right to a caller). Low volume, high stakes. */
export interface Council { tier: 'haiku' | 'sonnet' | 'opus'; model: string; review(i: ReviewInput): Promise<Review> }
/** Turns a script's fixed words into audio. Not connected to a live voice provider yet; tests supply a fake. */
export interface Recorder { record(language: string, text: string): Promise<{ contentType: ContentType; audioBase64: string; durationMs: number }> }

export interface LearnDeps {
  pool: pg.Pool;
  distillers?: Partial<Record<'haiku' | 'sonnet' | 'opus', Distiller>>;
  /** Keyed by the council's task: 'council_quality' and 'council_cx'; each by tier. */
  councils?: Partial<Record<'council_quality' | 'council_cx', Partial<Record<'haiku' | 'sonnet' | 'opus', Council>>>>;
  recorder?: Recorder;
}

// ------------------------------------------------------------------------------------------------ configuration
export interface LearningConfig {
  minSupport: number; similarity: number; minConfidence: number; driftMinSamples: number; driftSentimentDrop: number;
  driftUnheardRise: number; driftEscalationRise: number; voiceProviderId: string | null;
}
const DEFAULTS: LearningConfig = { minSupport: 20, similarity: 0.6, minConfidence: 0.85, driftMinSamples: 20, driftSentimentDrop: 0.3, driftUnheardRise: 0.2, driftEscalationRise: 0.15, voiceProviderId: null };

export async function getLearningConfig(c: pg.PoolClient, tenantId: string): Promise<LearningConfig> {
  const r = (await c.query('SELECT * FROM learning_config WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!r) return DEFAULTS;
  return {
    minSupport: r.min_support, similarity: Number(r.similarity), minConfidence: Number(r.min_confidence), driftMinSamples: r.drift_min_samples,
    driftSentimentDrop: Number(r.drift_sentiment_drop), driftUnheardRise: Number(r.drift_unheard_rise), driftEscalationRise: Number(r.drift_escalation_rise), voiceProviderId: r.voice_provider_id,
  };
}

export const learningConfigSchema = z.object({
  minSupport: z.number().int().min(2).max(100000).optional(), similarity: z.number().min(0.3).max(1).optional(), minConfidence: z.number().min(0.5).max(1).optional(),
  driftMinSamples: z.number().int().min(3).max(100000).optional(), driftSentimentDrop: z.number().min(0.05).max(2).optional(),
  driftUnheardRise: z.number().min(0.05).max(1).optional(), driftEscalationRise: z.number().min(0.05).max(1).optional(), voiceProviderId: z.string().uuid().nullable().optional(),
}).strict();

export async function setLearningConfig(c: pg.PoolClient, actorId: string | null, tenantId: string, patch: z.infer<typeof learningConfigSchema>) {
  const m = { ...(await getLearningConfig(c, tenantId)), ...patch };
  if (m.voiceProviderId) {
    const p = (await c.query('SELECT kind FROM providers WHERE id = $1', [m.voiceProviderId])).rows[0];
    if (p?.kind !== 'voice') throw new AppError(400, 'Pick a voice provider: its character rate prices the assessment.');
  }
  await c.query(
    `INSERT INTO learning_config (tenant_id, min_support, similarity, min_confidence, drift_min_samples, drift_sentiment_drop, drift_unheard_rise, drift_escalation_rise, voice_provider_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id) DO UPDATE SET min_support = $2, similarity = $3, min_confidence = $4, drift_min_samples = $5, drift_sentiment_drop = $6, drift_unheard_rise = $7, drift_escalation_rise = $8, voice_provider_id = $9, updated_at = now()`,
    [tenantId, m.minSupport, m.similarity, m.minConfidence, m.driftMinSamples, m.driftSentimentDrop, m.driftUnheardRise, m.driftEscalationRise, m.voiceProviderId]);
  await audit(c, actorId, 'learning.config', 'tenant', tenantId, { ...patch });
  return getLearningConfig(c, tenantId);
}

// ------------------------------------------------------------------------------------------------ logging every turn
interface Rec { type: string; workflow: string; node?: string; payload: Record<string, unknown> }

/**
 * Log the dynamic lines a request spoke, with the context they were said in (the kind and topic of the caller's last turn).
 * Values of the call's own variables go back as slots; a sensitive variable is never given, so none can appear.
 */
export async function logLearningTurns(
  c: pg.PoolClient,
  e: { tenantId: string; runId: string; callId: string | null; kind: string; records: Rec[]; vars: Record<string, unknown>; sensitive: readonly string[]; context: { kind: string; topic: string | null } },
) {
  if (e.kind === 'simulation') return;                    // a rehearsal is not evidence
  for (const r of e.records) {
    if (r.type !== 'say' || r.payload.strategy !== 'dynamic' || r.payload.promotion !== undefined || !r.node) continue;
    const line = String(r.payload.text ?? '');
    if (line.trim() === '') continue;
    const s = slotify(line, e.vars, e.sensitive);
    await c.query(
      `INSERT INTO learning_turns (tenant_id, run_id, call_id, workflow, node, language, context_kind, context_topic, text, synth_chars, slot_chars)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.tenantId, e.runId, e.callId, r.workflow, r.node, String(r.payload.lang ?? 'en'), e.context.kind, e.context.topic ?? '', s.text, Number(r.payload.synthChars ?? [...line].length), s.slotChars]);
  }
}

// ------------------------------------------------------------------------------------------------ status
export type PromotionStatus = 'in_review' | 'approved' | 'promoted' | 'demoted' | 'rejected';
const STATUS: Record<string, PromotionStatus> = {
  distilled: 'in_review', reviewed: 'in_review', regenerated: 'in_review', approved: 'approved', recorded: 'approved', promoted: 'promoted',
  drift_detected: 'promoted', demoted: 'demoted', rejected: 'rejected',
};
const LIVE: PromotionStatus[] = ['in_review', 'approved', 'promoted'];

const PROMO_COLS = `p.id, p.tenant_id, p.workflow, p.node, p.language, p.context_kind, p.context_topic, p.script, p.slots, p.support, p.variants,
  p.avg_synth_chars, p.avg_slot_chars, p.distilled_by, p.supersedes, p.created_at,
  (SELECT e.kind FROM promotion_events e WHERE e.promotion_id = p.id AND e.kind <> 'regenerated' ORDER BY e.id DESC LIMIT 1) AS last_kind`;
export interface PromotionRow {
  id: string; tenant_id: string; workflow: string; node: string; language: string; context_kind: string; context_topic: string; script: string; slots: string[];
  support: number; variants: number; avg_synth_chars: number; avg_slot_chars: number; distilled_by: string; supersedes: string | null; created_at: Date; last_kind: string; status: PromotionStatus;
}
const shape = (r: Record<string, unknown>): PromotionRow => ({ ...r, status: STATUS[r.last_kind as string] ?? 'in_review', avg_synth_chars: Number(r.avg_synth_chars), avg_slot_chars: Number(r.avg_slot_chars) }) as PromotionRow;

export async function listPromotions(c: pg.PoolClient, tenantId: string, status?: PromotionStatus) {
  const rows = (await c.query(`SELECT ${PROMO_COLS} FROM promotions p WHERE p.tenant_id = $1 ORDER BY p.created_at DESC`, [tenantId])).rows.map(shape);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export async function getPromotion(c: pg.PoolClient, id: string) {
  const r = (await c.query(`SELECT ${PROMO_COLS}, p.node_hash FROM promotions p WHERE p.id = $1`, [id])).rows[0];
  if (!r) throw new AppError(404, 'Promotion not found.');
  const events = (await c.query('SELECT id, kind, actor_id, reason, detail, created_at FROM promotion_events WHERE promotion_id = $1 ORDER BY id', [id])).rows;
  return { ...shape(r), events };
}

async function lock(c: pg.PoolClient, key: string) { await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]); }
/** Run something that spends money or calls a model at most once at a time per key; a second caller is told it is busy. */
async function exclusive<T>(pool: pg.Pool, key: string, fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const held = await pool.connect();
  try {
    if (!(await held.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key])).rows[0].ok) return { busy: true };
    try { return { busy: false, value: await fn() }; } finally { await held.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); }
  } finally { held.release(); }
}
async function event(c: pg.PoolClient, actorId: string | null, promotionId: string, kind: string, reason: string, detail: Record<string, unknown> = {}) {
  await c.query('INSERT INTO promotion_events (promotion_id, kind, actor_id, reason, detail) VALUES ($1,$2,$3,$4,$5)', [promotionId, kind, actorId, reason, JSON.stringify(detail)]);
}

/**
 * The scripts speaking right now: what a call looks up before it asks a model. A script is spoken only for the context
 * it was learned in, and only while the node still says what it said when the script was written.
 */
export async function activePromotions(c: pg.PoolClient, tenantId: string) {
  const rows = (await c.query(`SELECT ${PROMO_COLS}, p.node_hash FROM promotions p WHERE p.tenant_id = $1`, [tenantId])).rows.map((r) => ({ ...shape(r), node_hash: r.node_hash as string })).filter((r) => r.status === 'promoted');
  const byKey = new Map(rows.map((r) => [`${r.workflow}\n${r.node}\n${r.language}\n${r.context_kind}\n${r.context_topic}`, { id: r.id, script: r.script, hash: r.node_hash }]));
  return (workflow: string, node: { prompt?: string; text?: unknown }, id: string, language: string, context: { kind: string; topic: string }) => {
    const hit = byKey.get(`${workflow}\n${id}\n${language}\n${context.kind}\n${context.topic}`);
    return hit && hit.hash === hashNode(node) ? { id: hit.id, script: hit.script } : undefined;
  };
}

// ------------------------------------------------------------------------------------------------ clusters
const nodeHash = (def: WorkflowDefinition | undefined, node: string): string =>
  hashNode(def && Object.hasOwn(def.nodes, node) ? def.nodes[node] as { prompt?: string; text?: unknown } : undefined);

async function definitionFor(c: pg.PoolClient, runId: string, workflow: string): Promise<WorkflowDefinition | undefined> {
  const pins = (await c.query('SELECT pins FROM workflow_runs WHERE id = $1', [runId])).rows[0]?.pins as Record<string, string> | undefined;
  const vid = pins && Object.hasOwn(pins, workflow) ? pins[workflow] : undefined;
  return vid ? (await c.query('SELECT definition FROM workflow_versions WHERE id = $1', [vid])).rows[0]?.definition as WorkflowDefinition | undefined : undefined;
}

interface Group { workflow: string; node: string; language: string; contextKind: string; contextTopic: string; clusters: Cluster[]; turns: number; avgSynth: number; avgSlot: number }

/** Dynamic turns grouped by node and journey context, then clustered by wording. Only turns since the node's last demotion count: fresh evidence. */
export async function clusterGroups(c: pg.PoolClient, tenantId: string, cfg: LearningConfig, only?: { workflow?: string; node?: string }): Promise<Group[]> {
  const rows = (await c.query(
    `SELECT t.workflow, t.node, t.language, t.context_kind, t.context_topic, t.text, count(*)::int AS n, avg(t.synth_chars) AS synth, avg(t.slot_chars) AS slot
       FROM learning_turns t
      WHERE t.tenant_id = $1 AND ($2::text IS NULL OR t.workflow = $2) AND ($3::text IS NULL OR t.node = $3)
        AND t.created_at > coalesce((SELECT max(e.created_at) FROM promotion_events e JOIN promotions p ON p.id = e.promotion_id
                                      WHERE p.tenant_id = t.tenant_id AND p.workflow = t.workflow AND p.node = t.node AND p.language = t.language AND e.kind = 'demoted'), '-infinity')
      GROUP BY 1,2,3,4,5,6`, [tenantId, only?.workflow ?? null, only?.node ?? null])).rows;
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) { const k = [r.workflow, r.node, r.language, r.context_kind, r.context_topic].join('\n'); byKey.set(k, [...(byKey.get(k) ?? []), r]); }
  return [...byKey.values()].map((g) => {
    const total = g.reduce((s, r) => s + r.n, 0);
    return {
      workflow: g[0].workflow, node: g[0].node, language: g[0].language, contextKind: g[0].context_kind, contextTopic: g[0].context_topic,
      clusters: clusterTurns(g.map((r) => ({ text: r.text as string, count: r.n as number })), cfg.similarity), turns: total,
      avgSynth: g.reduce((s, r) => s + Number(r.synth) * r.n, 0) / total, avgSlot: g.reduce((s, r) => s + Number(r.slot) * r.n, 0) / total,
    };
  });
}

/** Clusters and how close each is to the frequency threshold: what the console shows before anything is promoted. */
export async function clusterReport(c: pg.PoolClient, tenantId: string) {
  const cfg = await getLearningConfig(c, tenantId);
  const groups = await clusterGroups(c, tenantId, cfg);
  return {
    threshold: cfg.minSupport,
    clusters: groups.flatMap((g) => g.clusters.map((k) => ({
      workflow: g.workflow, node: g.node, language: g.language, context: g.contextKind + (g.contextTopic ? `/${g.contextTopic}` : ''),
      script: k.canonical, support: k.support, variants: k.variants, ready: k.support >= cfg.minSupport, percentOfThreshold: Math.min(100, Math.round((k.support / cfg.minSupport) * 100)),
    }))).sort((a, b) => b.support - a.support),
  };
}

// ------------------------------------------------------------------------------------------------ distilling
/**
 * Every cluster past the frequency threshold gets one canonical script, with the slots marked: the cluster's own
 * medoid by rule, or, where a distiller model is configured, a model's version (stepping up a tier when it is unsure).
 * A script must pass the rule checks before anyone is asked about it. A node with a script in review, approved or
 * promoted gets no second one.
 */
export async function distil(d: LearnDeps, actorId: string | null, e: { tenantId: string; workflow?: string; node?: string }) {
  const plan = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const cfg = await getLearningConfig(c, e.tenantId);
    return { cfg, groups: await clusterGroups(c, e.tenantId, cfg, e), primary: await modelFor(c, 'distill_script') };
  });
  const created: string[] = []; const skipped: { workflow: string; node: string; reason: string }[] = [];
  for (const g of plan.groups) {
    const top = g.clusters[0];
    if (!top || top.support < plan.cfg.minSupport) continue;
    const ctx = await withActor(d.pool, { kind: 'internal' }, async (c) => {
      const last = (await c.query('SELECT run_id FROM learning_turns WHERE tenant_id = $1 AND workflow = $2 AND node = $3 ORDER BY id DESC LIMIT 1', [e.tenantId, g.workflow, g.node])).rows[0];
      const def = last ? await definitionFor(c, last.run_id, g.workflow) : undefined;
      const earlier = (await c.query(
        `SELECT ${PROMO_COLS} FROM promotions p WHERE p.tenant_id = $1 AND p.workflow = $2 AND p.node = $3 AND p.language = $4 AND p.context_kind = $5 AND p.context_topic = $6`,
        [e.tenantId, g.workflow, g.node, g.language, g.contextKind, g.contextTopic])).rows.map(shape);
      return { def, avoid: earlier.map((p) => p.script), open: earlier.some((p) => LIVE.includes(p.status)) };
    });
    // A node that already has a script in review, approved or promoted is not asked about again: that would only spend a model call.
    if (ctx.open) continue;
    const node = ctx.def && Object.hasOwn(ctx.def.nodes, g.node) ? ctx.def.nodes[g.node] as { prompt?: string } : undefined;
    const nodePrompt = node?.prompt ?? '';
    let script = top.canonical; let by = 'rules'; let confidence = 1;
    const usage: { model: string; tier: Tier; inputTokens: number; outputTokens: number; confidence: number; escalatedFrom: string | null }[] = [];
    const first = plan.primary ? d.distillers?.[plan.primary.tier] : undefined;
    if (first) {
      const input: DistillInput = { workflow: g.workflow, node: g.node, nodePrompt, slots: slotsIn(top.canonical), examples: top.members.slice(0, 10), avoid: ctx.avoid };
      let model: Distiller = first; let out = await model.distill(input); let from: string | null = null;
      usage.push({ model: model.model, tier: model.tier, inputTokens: out.inputTokens, outputTokens: out.outputTokens, confidence: out.confidence, escalatedFrom: null });
      const up = plan.primary?.escalateTo ? d.distillers?.[plan.primary.escalateTo] : undefined;
      if (out.confidence < plan.cfg.minConfidence && up) {
        from = model.tier; model = up; out = await model.distill(input);
        usage.push({ model: model.model, tier: model.tier, inputTokens: out.inputTokens, outputTokens: out.outputTokens, confidence: out.confidence, escalatedFrom: from });
      }
      if (normalizeSpoken(out.script) !== '') { script = normalizeSpoken(out.script); by = model.model; confidence = out.confidence; }
    }
    // Whatever a model was asked is recorded, whether or not its answer is used.
    const spill = async () => {
      if (!usage.length) return;
      await withActor(d.pool, { kind: 'internal' }, async (c) => {
        for (const u of usage) await recordDecision(c, { tenantId: e.tenantId, task: 'distill_script', subjectType: 'learning_node', subjectId: `${g.workflow}:${g.node}`, decision: 'rejected',
          reason: `A script for ${g.node} was written but not used.`, model: u.model, tier: u.tier, inputTokens: u.inputTokens, outputTokens: u.outputTokens, confidence: u.confidence, escalatedFrom: u.escalatedFrom });
      });
    };
    if (ctx.avoid.includes(script)) { await spill(); skipped.push({ workflow: g.workflow, node: g.node, reason: 'This script was already proposed for this node and is not new evidence.' }); continue; }
    const check = checkScript(script, { variables: ctx.def?.variables ?? [], sensitive: ctx.def?.sensitiveVariables ?? [] });
    // A model's script that fails the rules gives way to the cluster's own wording, which is what callers actually heard.
    if (!check.ok && by !== 'rules') {
      const fallback = checkScript(top.canonical, { variables: ctx.def?.variables ?? [], sensitive: ctx.def?.sensitiveVariables ?? [] });
      if (fallback.ok && !ctx.avoid.includes(top.canonical)) { script = top.canonical; by = 'rules'; confidence = 1; check.ok = true; check.problems = []; }
    }
    if (!check.ok) { await spill(); skipped.push({ workflow: g.workflow, node: g.node, reason: check.problems.join(' ') }); continue; }

    const id = await withActor(d.pool, { kind: 'internal' }, async (c) => {
      await lock(c, `promo:${e.tenantId}:${g.workflow}:${g.node}:${g.language}:${g.contextKind}:${g.contextTopic}`);
      const open = (await c.query(`SELECT ${PROMO_COLS} FROM promotions p WHERE p.tenant_id = $1 AND p.workflow = $2 AND p.node = $3 AND p.language = $4 AND p.context_kind = $5 AND p.context_topic = $6`,
        [e.tenantId, g.workflow, g.node, g.language, g.contextKind, g.contextTopic])).rows.map(shape);
      if (open.some((p) => LIVE.includes(p.status))) return null;
      const prev = open.filter((p) => p.status === 'demoted').sort((a, b) => +b.created_at.getTime() - a.created_at.getTime())[0];
      const row = (await c.query(
        `INSERT INTO promotions (tenant_id, workflow, node, language, context_kind, context_topic, script, slots, support, variants, avg_synth_chars, avg_slot_chars, node_hash, distilled_by, supersedes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [e.tenantId, g.workflow, g.node, g.language, g.contextKind, g.contextTopic, script, slotsIn(script), top.support, top.variants, g.avgSynth.toFixed(2), g.avgSlot.toFixed(2), nodeHash(ctx.def, g.node), by, prev?.id ?? null, actorId])).rows[0].id as string;
      await event(c, actorId, row, 'distilled', `${top.support} similar turns in one journey context (${g.contextKind}${g.contextTopic ? `/${g.contextTopic}` : ''}) passed the threshold of ${plan.cfg.minSupport}.`,
        { support: top.support, variants: top.variants, threshold: plan.cfg.minSupport, source: by, confidence });
      for (const u of usage) {
        await recordDecision(c, { tenantId: e.tenantId, task: 'distill_script', subjectType: 'promotion', subjectId: row, decision: 'proceeded', reason: `Wrote a script for ${g.node} from ${top.support} turns.`,
          model: u.model, tier: u.tier, inputTokens: u.inputTokens, outputTokens: u.outputTokens, confidence: u.confidence, escalatedFrom: u.escalatedFrom });
      }
      await audit(c, actorId, 'learning.distil', 'promotion', row, { workflow: g.workflow, node: g.node, support: top.support });
      return row;
    });
    if (id) created.push(id); else await spill();
  }
  return { created, skipped };
}

// ------------------------------------------------------------------------------------------------ councils
const COUNCILS = [['quality', 'council_quality'], ['cx', 'council_cx']] as const;

/** The rule checks a script must pass, against the node as it is defined now. */
async function scriptChecks(c: pg.PoolClient, p: PromotionRow) {
  const last = (await c.query('SELECT run_id FROM learning_turns WHERE tenant_id = $1 AND workflow = $2 AND node = $3 ORDER BY id DESC LIMIT 1', [p.tenant_id, p.workflow, p.node])).rows[0];
  const def = last ? await definitionFor(c, last.run_id, p.workflow) : undefined;
  const node = def && Object.hasOwn(def.nodes, p.node) ? def.nodes[p.node] as { prompt?: string } : undefined;
  return { checks: checkScript(p.script, { variables: def?.variables ?? [], sensitive: def?.sensitiveVariables ?? [] }), nodePrompt: node?.prompt ?? '' };
}

/**
 * The Quality Council and the Customer Experience Council each review a script. Only when both are present and both
 * pass with high confidence is it approved, automatically; a clear failure from either turns it down; anything else
 * (no council, a low-confidence answer) waits for a person. Every opinion goes in the audit trail with its tokens.
 */
export async function reviewPromotion(d: LearnDeps, actorId: string | null, promotionId: string) {
  const ctx = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const p = await getPromotion(c, promotionId);
    if (p.status !== 'in_review') throw new AppError(409, `This script is ${p.status}; it is not waiting for review.`);
    const cfg = await getLearningConfig(c, p.tenant_id as string);
    const examples = (await c.query(
      `SELECT text FROM learning_turns WHERE tenant_id = $1 AND workflow = $2 AND node = $3 AND language = $4 GROUP BY text ORDER BY count(*) DESC LIMIT 5`, [p.tenant_id, p.workflow, p.node, p.language])).rows.map((r) => r.text as string);
    const { checks, nodePrompt } = await scriptChecks(c, p);
    const picks = [];
    for (const [name, task] of COUNCILS) picks.push({ name, task, cfg: await modelFor(c, task) });
    return { p, cfg, examples, nodePrompt, checks, picks };
  });
  const opinions: { council: string; available: boolean; pass?: boolean; confidence?: number; concerns?: string[]; model?: string; tier?: Tier; inputTokens?: number; outputTokens?: number }[] = [];
  for (const pick of ctx.picks) {
    const council = pick.cfg ? d.councils?.[pick.task]?.[pick.cfg.tier] : undefined;
    if (!council) { opinions.push({ council: pick.name, available: false }); continue; }
    const r = await council.review({ council: pick.name, script: ctx.p.script as string, nodePrompt: ctx.nodePrompt, support: ctx.p.support as number, variants: ctx.p.variants as number, examples: ctx.examples, checks: ctx.checks.problems });
    opinions.push({ council: pick.name, available: true, pass: r.pass, confidence: r.confidence, concerns: r.concerns, model: council.model, tier: council.tier, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
  }
  const clearFail = opinions.find((o) => o.available && o.pass === false && (o.confidence ?? 0) >= ctx.cfg.minConfidence);
  const allPass = opinions.every((o) => o.available && o.pass === true && (o.confidence ?? 0) >= ctx.cfg.minConfidence) && ctx.checks.ok;
  // The councils were asked and their tokens spent: that is recorded even if someone else got to the script first.
  await withActor(d.pool, { kind: 'internal' }, async (c) => {
    for (const o of opinions) {
      if (!o.available) continue;
      await recordDecision(c, { tenantId: ctx.p.tenant_id, task: `council_${o.council}`, subjectType: 'promotion', subjectId: promotionId, decision: o.pass ? 'proceeded' : 'rejected',
        reason: o.concerns?.join(' ') || (o.pass ? 'No concerns.' : 'Not approved.'), model: o.model, tier: o.tier, inputTokens: o.inputTokens, outputTokens: o.outputTokens, confidence: o.confidence });
    }
  });
  await withActor(d.pool, { kind: 'internal' }, async (c) => {
    await lock(c, `promo:${promotionId}`);
    const now = await getPromotion(c, promotionId);
    if (now.status !== 'in_review') throw new AppError(409, `This script is ${now.status}; it is not waiting for review.`);
    for (const o of opinions) {
      await event(c, actorId, promotionId, 'reviewed', o.available ? `${o.council} council: ${o.pass ? 'pass' : 'does not pass'} (${o.confidence}).${o.concerns?.length ? ` ${o.concerns.join(' ')}` : ''}` : `${o.council} council: none is set up, so this needs a person.`, { ...o });
    }
    if (clearFail) {
      await event(c, actorId, promotionId, 'rejected', `The ${clearFail.council} council turned it down: ${clearFail.concerns?.join(' ') || 'no reason given'}.`, { automatic: true });
    } else if (allPass) {
      await event(c, actorId, promotionId, 'approved', 'Both councils passed it with high confidence, so it was approved automatically.', { automatic: true });
    }
    await audit(c, actorId, 'learning.review', 'promotion', promotionId, { automatic: Boolean(clearFail || allPass) });
  });
  const status = (await withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, promotionId))).status;
  let audioError: string | undefined;
  if (status === 'approved') { try { await finishPromotion(d, actorId, promotionId); } catch (err) { audioError = redactNumbers((err as Error).message).slice(0, 300); } }
  const promotion = await withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, promotionId));
  return audioError ? { ...promotion, audioError } : promotion;
}

/** A person approves or turns down a script that was waiting for them. */
export async function decidePromotion(d: LearnDeps, actorId: string, promotionId: string, e: { decision: 'approved' | 'rejected'; note?: string }) {
  if (e.decision === 'rejected' && !e.note?.trim()) throw new AppError(400, 'Say why you are turning this down.');
  await withActor(d.pool, { kind: 'internal' }, async (c) => {
    await lock(c, `promo:${promotionId}`);
    const p = await getPromotion(c, promotionId);
    if (p.status !== 'in_review') throw new AppError(409, `This script is ${p.status}; it is not waiting for a decision.`);
    if (e.decision === 'approved') {
      const { checks } = await scriptChecks(c, p);
      if (!checks.ok) throw new AppError(409, `This script fails the rule checks, so it cannot be approved: ${checks.problems.join(' ')}`);
    }
    await event(c, actorId, promotionId, e.decision === 'approved' ? 'approved' : 'rejected', e.note?.trim() || (e.decision === 'approved' ? 'Approved by a person.' : 'Turned down.'), { automatic: false });
    await audit(c, actorId, `learning.${e.decision}`, 'promotion', promotionId, {});
  });
  // The approval stands even if the audio cannot be made now; the sweep tries again.
  let audioError: string | undefined;
  if (e.decision === 'approved') { try { await finishPromotion(d, actorId, promotionId); } catch (err) { audioError = redactNumbers((err as Error).message).slice(0, 300); } }
  const promotion = await withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, promotionId));
  return audioError ? { ...promotion, audioError } : promotion;
}

// ------------------------------------------------------------------------------------------------ audio, then promotion
const fixedParts = (script: string) => script.split(new RegExp(SLOT_RE.source, 'g')).filter((_, i) => i % 2 === 0).map(normalizeSpoken).filter((s) => s !== '');

/**
 * An approved script is promoted once every fixed phrase in it has a recording of exactly those words. Missing ones are
 * made by the recorder where there is one; without one the script stays approved, still spoken live, until recordings
 * are added by hand. Safe to run again.
 */
export async function finishPromotion(d: LearnDeps, actorId: string | null, promotionId: string) {
  // Recording spends money, so only one finish per script runs at a time; a second caller just sees where it stands.
  const r = await exclusive(d.pool, `finish:${promotionId}`, () => finishInner(d, actorId, promotionId));
  return r.busy ? withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, promotionId)) : r.value;
}

async function finishInner(d: LearnDeps, actorId: string | null, promotionId: string) {
  const state = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const p = await getPromotion(c, promotionId);
    if (p.status !== 'approved') return null;
    const index = await recordingIndex(c, p.tenant_id as string);
    return { p, missing: fixedParts(p.script as string).filter((t) => !index.find(p.language as string, t)) };
  });
  if (!state) return null;
  let made = 0; let madeChars = 0;
  if (state.missing.length && d.recorder) {
    for (const text of state.missing) {
      const audio = await d.recorder.record(state.p.language as string, text);
      await withActor(d.pool, { kind: 'internal' }, (c) => addRecording(c, actorId, { tenantId: state.p.tenant_id as string, language: state.p.language as string, text, label: `Learned: ${state.p.node}`, ...audio }));
      made++; madeChars += [...text].length;
    }
  }
  return withActor(d.pool, { kind: 'internal' }, async (c) => {
    await lock(c, `promo:${promotionId}`);
    const p = await getPromotion(c, promotionId);
    if (p.status !== 'approved') return p;
    const index = await recordingIndex(c, p.tenant_id as string);
    const stillMissing = fixedParts(p.script as string).filter((t) => !index.find(p.language as string, t));
    if (made > 0) await event(c, actorId, promotionId, 'recorded', `${made} phrase${made === 1 ? '' : 's'} recorded (${madeChars} characters, spoken once).`, { phrases: made, characters: madeChars });
    if (stillMissing.length) return p;               // waiting for audio
    const financial = await safeAssess(c, p, 'promote');
    await event(c, actorId, promotionId, 'promoted', 'Every fixed phrase has a recording, so this node now plays its script instead of asking a model.', { financial });
    await audit(c, actorId, 'learning.promote', 'promotion', promotionId, { node: p.node });
    return getPromotion(c, promotionId);
  });
}

/** Promote anything approved whose audio has arrived since. Run on a schedule. */
export async function sweepAudio(d: LearnDeps, actorId: string | null) {
  const ids = await withActor(d.pool, { kind: 'internal' }, async (c) => (await c.query('SELECT id FROM promotions')).rows.map((r) => r.id as string));
  const promoted: string[] = []; const failed: string[] = [];
  for (const id of ids) {
    const before = await withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, id));
    if (before.status !== 'approved') continue;
    try { const after = await finishPromotion(d, actorId, id); if (after?.status === 'promoted') promoted.push(id); }
    catch { failed.push(id); }       // one script's audio trouble must not stop the rest
  }
  return { promoted, audioFailed: failed };
}

// ------------------------------------------------------------------------------------------------ drift
interface Reaction { n: number; sentiment: number | null; unheardRate: number | null; escalationRate: number | null; runs: number }

async function reactions(
  c: pg.PoolClient, p: { tenant_id: string; workflow: string; node: string; language: string },
  o: { from: Date | null; to: Date | null; promotionId: string | null; latest: number },
): Promise<Reaction> {
  const q = (await c.query(
    `SELECT count(*)::int AS n, avg(x.sent) AS sentiment, avg(CASE WHEN x.unheard THEN 1 ELSE 0 END) AS unheard,
            count(DISTINCT x.run_id)::int AS runs, count(DISTINCT x.run_id) FILTER (WHERE x.escalated)::int AS escalated
       FROM (SELECT s.run_id, (h.payload->'analysis'->>'sentiment')::numeric AS sent, ((h.payload->'analysis'->>'understood') = 'false') AS unheard,
                    (r.state->'escalation'->>'node' = s.node) AS escalated
               FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
               JOIN LATERAL (SELECT payload FROM workflow_run_steps h WHERE h.run_id = s.run_id AND h.seq > s.seq AND h.type = 'heard' AND h.node = s.node AND h.workflow = s.workflow ORDER BY h.seq LIMIT 1) h ON true
              WHERE r.tenant_id = $1 AND r.kind IN ('live', 'test') AND s.type = 'say' AND s.workflow = $2 AND s.node = $3
                AND coalesce(s.payload->>'lang', 'en') = $4
                AND (CASE WHEN $5::text IS NULL THEN NOT (s.payload ? 'promotion') ELSE s.payload->>'promotion' = $5 END)
                AND h.payload ? 'analysis'
                AND ($6::timestamptz IS NULL OR s.created_at > $6) AND ($7::timestamptz IS NULL OR s.created_at <= $7)
              ORDER BY s.created_at DESC, s.id DESC LIMIT $8) x`,
    [p.tenant_id, p.workflow, p.node, p.language, o.promotionId, o.from, o.to, o.latest])).rows[0];
  return {
    n: q.n, runs: q.runs, sentiment: q.sentiment === null ? null : Number(q.sentiment), unheardRate: q.n ? Number(q.unheard) : null, escalationRate: q.runs ? q.escalated / q.runs : null,
  };
}

export interface DriftVerdict { drifted: boolean; judged: boolean; reasons: string[]; baseline: Reaction; promoted: Reaction }

/**
 * Compare how callers reacted to the live (model-written) line before promotion with how they react to the script now:
 * mood, being understood, escalating. The rule screen is cheap and runs on every promoted node. A change to the node's
 * own definition drifts it at once: the script was written for words that are no longer there.
 */
export async function driftVerdict(c: pg.PoolClient, promotionId: string): Promise<DriftVerdict> {
  const p = await getPromotion(c, promotionId);
  const cfg = await getLearningConfig(c, p.tenant_id as string);
  const at = new Date((p.events as { kind: string; created_at: Date }[]).filter((e) => e.kind === 'promoted').pop()!.created_at);
  // The latest reactions are what counts: a script that served well for a long time and then went bad must not be averaged out.
  const baseline = await reactions(c, p, { from: null, to: at, promotionId: null, latest: 1000 });
  const promoted = await reactions(c, p, { from: at, to: null, promotionId, latest: Math.max(cfg.driftMinSamples * 5, 100) });
  const reasons: string[] = [];
  const latest = (await c.query(
    `SELECT s.run_id FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE r.tenant_id = $1 AND r.kind IN ('live', 'test') AND s.workflow = $2 AND s.node = $3 AND s.type = 'say' AND s.created_at > $4 ORDER BY r.started_at DESC, s.id DESC LIMIT 1`, [p.tenant_id, p.workflow, p.node, at])).rows[0];
  if (latest) {
    const def = await definitionFor(c, latest.run_id, p.workflow as string);
    const stored = (await c.query('SELECT node_hash FROM promotions WHERE id = $1', [promotionId])).rows[0].node_hash as string;
    if (def && nodeHash(def, p.node as string) !== stored) reasons.push('The node was changed after its script was written, so the script no longer matches it.');
  }
  const judged = promoted.n >= cfg.driftMinSamples && baseline.n >= 3;
  if (judged) {
    if (baseline.sentiment !== null && promoted.sentiment !== null && baseline.sentiment - promoted.sentiment >= cfg.driftSentimentDrop)
      reasons.push(`Callers' mood fell from ${baseline.sentiment.toFixed(2)} to ${promoted.sentiment.toFixed(2)} after the script.`);
    if (baseline.unheardRate !== null && promoted.unheardRate !== null && promoted.unheardRate - baseline.unheardRate >= cfg.driftUnheardRise)
      reasons.push(`Callers not understood rose from ${Math.round(baseline.unheardRate * 100)}% to ${Math.round(promoted.unheardRate * 100)}%.`);
    if (baseline.escalationRate !== null && promoted.escalationRate !== null && promoted.escalationRate - baseline.escalationRate >= cfg.driftEscalationRise)
      reasons.push(`Escalations at this node rose from ${Math.round(baseline.escalationRate * 100)}% to ${Math.round(promoted.escalationRate * 100)}% of calls.`);
  }
  return { drifted: reasons.length > 0, judged, reasons, baseline, promoted };
}

/** The worst few calls on the promoted script, for people to listen to. */
async function replaysFor(c: pg.PoolClient, p: { tenant_id: string; workflow: string; node: string }, since: Date) {
  return (await c.query(
    `SELECT s.run_id AS "runId", r.call_id AS "callId", (h.payload->'analysis'->>'sentiment')::numeric AS sentiment
       FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
       JOIN LATERAL (SELECT payload FROM workflow_run_steps h WHERE h.run_id = s.run_id AND h.seq > s.seq AND h.type = 'heard' AND h.node = s.node ORDER BY h.seq LIMIT 1) h ON true
      WHERE r.tenant_id = $1 AND s.workflow = $2 AND s.node = $3 AND s.type = 'say' AND s.payload ? 'promotion' AND s.created_at > $4 AND h.payload ? 'analysis'
      ORDER BY sentiment ASC LIMIT 5`, [p.tenant_id, p.workflow, p.node, since])).rows.map((r) => ({ runId: r.runId as string, callId: r.callId as string | null, sentiment: Number(r.sentiment) }));
}

/**
 * Put a promoted node back to live speech. The script is withdrawn, the node asks a model again, and the cost change is
 * recorded. A node that drifted also gets a replay of its worst calls, and a note on what happens to the script.
 */
export async function demote(c: pg.PoolClient, actorId: string | null, promotionId: string, e: { reason: string; drift?: DriftVerdict }) {
  await lock(c, `promo:${promotionId}`);
  const p = await getPromotion(c, promotionId);
  if (p.status !== 'promoted') throw new AppError(409, `This script is ${p.status}; only a promoted one can be demoted.`);
  if (!e.reason.trim()) throw new AppError(400, 'Say why this is being demoted.');
  const at = new Date((p.events as { kind: string; created_at: Date }[]).filter((x) => x.kind === 'promoted').pop()!.created_at);
  const replays = await replaysFor(c, p as never, at);
  const financial = await safeAssess(c, p, 'demote');
  if (e.drift) await event(c, actorId, promotionId, 'drift_detected', e.drift.reasons.join(' '), { baseline: e.drift.baseline, promoted: e.drift.promoted });
  await event(c, actorId, promotionId, 'demoted', e.reason, { forced: !e.drift, replays, financial });
  // The script is regenerated from fresh live turns: only turns since this demotion count, and a script already tried is not offered again.
  await event(c, actorId, promotionId, 'regenerated', 'The node speaks live again. A new script is drawn up from the live turns that follow, once they reach the threshold and give a wording not tried before.', { awaiting: 'fresh live turns' });
  await audit(c, actorId, e.drift ? 'learning.demote_drift' : 'learning.demote', 'promotion', promotionId, { node: p.node });
  return getPromotion(c, promotionId);
}

/** Check one promoted script, and demote it if it drifted. */
export async function checkDrift(d: LearnDeps, actorId: string | null, promotionId: string) {
  return withActor(d.pool, { kind: 'internal' }, async (c) => {
    const p = await getPromotion(c, promotionId);
    if (p.status !== 'promoted') throw new AppError(409, `This script is ${p.status}; only a promoted one is monitored.`);
    const verdict = await driftVerdict(c, promotionId);
    if (!verdict.drifted) return { verdict, promotion: p };
    const promotion = await demote(c, actorId, promotionId, { reason: `Drift: ${verdict.reasons.join(' ')}`, drift: verdict });
    return { verdict, promotion };
  });
}

/** Screen every promoted node. Run on a schedule; cheap rules, no model. */
export async function sweepDrift(d: LearnDeps, actorId: string | null) {
  const ids = await withActor(d.pool, { kind: 'internal' }, async (c) => (await c.query('SELECT id FROM promotions')).rows.map((r) => r.id as string));
  const demoted: string[] = []; const failed: string[] = []; const unjudged: string[] = []; let checked = 0;
  for (const id of ids) {
    const st = (await withActor(d.pool, { kind: 'internal' }, (c) => getPromotion(c, id))).status;
    if (st !== 'promoted') continue;
    checked++;
    try { const r = await checkDrift(d, actorId, id); if (r.verdict.drifted) demoted.push(id); else if (!r.verdict.judged) unjudged.push(id); }
    catch { failed.push(id); }   // one node's trouble must not stop the screen of the rest, but it is reported
  }
  // A node that could not be judged (too few reactions, or no listening step) is named: a silent monitor is worse than none.
  return { checked, demoted, unjudged, driftFailed: failed };
}

// ------------------------------------------------------------------------------------------------ the cost change
/**
 * What promotion (or demotion) does to the cost of a node, in exact money at the voice provider's rate. Per use: the
 * characters spoken live fall from the whole line to the slots; the fixed words are recorded once. Demotion is the same
 * change the other way, with what the script saved while it ran.
 */
export async function assess(c: pg.PoolClient, p: PromotionRow, direction: 'promote' | 'demote') {
  const cfg = await getLearningConfig(c, p.tenant_id as string);
  const before = Math.round(Number(p.avg_synth_chars)); const after = Math.round(Number(p.avg_slot_chars));
  const oneTime = fixedChars(p.script as string);
  const uses = (await c.query(
    `SELECT count(*)::int AS n FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE r.tenant_id = $1 AND s.workflow = $2 AND s.node = $3 AND s.type = 'say' AND s.payload ? 'promotion' AND s.payload->>'promotion' = $4`, [p.tenant_id, p.workflow, p.node, p.id])).rows[0].n as number;
  let price: ((n: number) => bigint) | null = null; let confirmed: boolean | null = null;
  if (cfg.voiceProviderId) { const pr = await ttsPricing(c, cfg.voiceProviderId, new Date()); price = pr.price; confirmed = pr.confirmed; }
  const usd = (chars: number) => (price ? fromScaled(price(chars)) : null);
  const savedChars = Math.max(0, before - after);
  const savedPerUse = price ? price(savedChars) : null;
  return {
    direction,
    perUse: { liveBefore: { chars: before, costUsd: usd(before) }, afterPromotion: { chars: after, costUsd: usd(after) }, saved: { chars: savedChars, costUsd: usd(savedChars) } },
    oneTime: { chars: oneTime, costUsd: usd(oneTime), note: 'The fixed words are recorded once.' },
    breakEvenUses: savedChars > 0 ? Math.ceil(oneTime / savedChars) : null,
    usesWhilePromoted: uses,
    realisedSavingUsd: price && savedPerUse !== null ? fromScaled(savedPerUse * BigInt(uses)) : null,
    ratesConfirmed: confirmed,
    note: direction === 'promote'
      ? 'Prices speech synthesis only, per use of this node, from the average of the live turns it replaces. Model tokens saved are not priced.'
      : 'Going back to live speech costs the per-use saving again from now on; the realised saving is what the script saved while it ran.',
  };
}

/** The assessment is useful, not essential: if it cannot be worked out (no rate yet) the promotion still goes ahead. A savepoint keeps a failure from aborting the transaction. */
async function safeAssess(c: pg.PoolClient, p: PromotionRow, direction: 'promote' | 'demote') {
  await c.query('SAVEPOINT assess');
  try { const r = await assess(c, p, direction); await c.query('RELEASE SAVEPOINT assess'); return r; }
  catch { await c.query('ROLLBACK TO SAVEPOINT assess'); return null; }
}

export async function promotionFinancial(c: pg.PoolClient, promotionId: string) {
  const p = await getPromotion(c, promotionId);
  return assess(c, p, p.status === 'demoted' ? 'demote' : 'promote');
}

/** What the loop is doing, for the console and the Control Tower. */
export async function learningSummary(c: pg.PoolClient, tenantId: string) {
  const all = await listPromotions(c, tenantId);
  const count = (s: PromotionStatus) => all.filter((p) => p.status === s).length;
  return { inReview: count('in_review'), approved: count('approved'), promoted: count('promoted'), demoted: count('demoted'), rejected: count('rejected') };
}
