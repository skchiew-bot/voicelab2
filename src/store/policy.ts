import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { PolicyGuard } from '../workflows/engine.js';
import { classifyPolicyChange, phraseViolation, diffPolicy, evaluate, ruleProblems, type Rule, type Verdict } from '../policy/rules.js';
import type { Vars } from '../workflows/conditions.js';
import type { Json } from '../workflows/definition.js';
import { audit } from './audit.js';
import { cleanNote } from './cases.js';

const lock = (c: pg.PoolClient, key: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
const label = (v: { major: number; minor: number }) => `${v.major}.${v.minor}`;

// ------------------------------------------------------------------------------------------------ approval levels
export const levelsSchema = z.object({ levels: z.array(z.string().min(1).max(60)).min(2).max(5) }).strict();
/** Who must approve a policy change, in order. At least two levels: a policy is never settled by one pair of eyes. */
export async function setLevels(c: pg.PoolClient, actorId: string | null, tenantId: string, e: z.infer<typeof levelsSchema>) {
  if (new Set(e.levels.map((l) => l.toLowerCase())).size !== e.levels.length) throw new AppError(400, 'A level is named once.');
  await c.query(`INSERT INTO policy_levels (tenant_id, levels) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET levels = $2, updated_at = now()`, [tenantId, e.levels]);
  await audit(c, actorId, 'policy.levels', 'tenant', tenantId, { levels: e.levels.length });
  return getLevels(c, tenantId);
}
export const getLevels = async (c: pg.PoolClient, tenantId: string): Promise<string[]> => (await c.query('SELECT levels FROM policy_levels WHERE tenant_id = $1', [tenantId])).rows[0]?.levels ?? [];

// ------------------------------------------------------------------------------------------------ versions
interface VersionRow { id: string; tenant_id: string; major: number; minor: number; rules: Rule[]; summary: string; diff: string[]; status: string; proposed_by: string | null; rollback_of: string | null; created_at: Date; activated_at: Date | null }

export async function livePolicy(c: pg.PoolClient, tenantId: string): Promise<{ id: string; label: string; rules: Rule[] } | null> {
  const r = (await c.query(`SELECT id, major, minor, rules FROM policy_versions WHERE tenant_id = $1 AND status = 'live'`, [tenantId])).rows[0];
  return r ? { id: r.id, label: label(r), rules: r.rules } : null;
}

export async function getVersion(c: pg.PoolClient, id: string) {
  const v = (await c.query('SELECT * FROM policy_versions WHERE id = $1', [id])).rows[0] as VersionRow | undefined;
  if (!v) throw new AppError(404, 'Policy version not found.');
  const levels = await getLevels(c, v.tenant_id);
  const approvals = (await c.query('SELECT level, decision, note, decided_by, at FROM policy_approvals WHERE version_id = $1 ORDER BY level', [id])).rows;
  const progress = levels.map((name, level) => ({ level, name, ...(approvals.find((a) => a.level === level) ?? { decision: null, note: null, decided_by: null, at: null }) }));
  return { id: v.id, tenantId: v.tenant_id, version: label(v), status: v.status, summary: v.summary, rules: v.rules, diff: v.diff, proposedBy: v.proposed_by, rollbackOf: v.rollback_of, createdAt: v.created_at, activatedAt: v.activated_at, progress, nextLevel: approvals.length };
}

export async function policyOverview(c: pg.PoolClient, tenantId: string) {
  const rows = (await c.query('SELECT id FROM policy_versions WHERE tenant_id = $1 ORDER BY major DESC, minor DESC', [tenantId])).rows;
  const versions = await Promise.all(rows.map((r) => getVersion(c, r.id)));
  return { levels: await getLevels(c, tenantId), live: versions.find((v) => v.status === 'live') ?? null, pending: versions.find((v) => v.status === 'pending' || v.status === 'approved') ?? null, history: versions };
}

export const proposeSchema = z.object({ rules: z.array(z.any()).min(1).max(100), summary: z.string().min(1).max(500), rollbackOf: z.string().uuid().optional() }).strict();

/**
 * Propose a change to the policy: what it would be, why, and in words what differs. It needs every level's approval,
 * each from a different person who is not the proposer, and then someone other than the proposer to put it live. A
 * change to what the policy permits or forbids is a new major version; rewording a message is minor. Going back to an
 * older policy is a new proposal like any other, and goes through the same approvals.
 */
export async function propose(c: pg.PoolClient, actorId: string, tenantId: string, e: z.infer<typeof proposeSchema>) {
  const problems = ruleProblems(e.rules);
  if (problems.length) throw new AppError(400, `This is not a usable policy: ${problems.join(' ')}`);
  const rules = e.rules as Rule[];
  cleanNote(e.summary, 'summary');
  await lock(c, `policy:${tenantId}`);
  const levels = await getLevels(c, tenantId);
  if (levels.length < 2) throw new AppError(409, 'Set up the approval levels (at least two) before proposing a policy.');
  if ((await c.query(`SELECT 1 FROM policy_versions WHERE tenant_id = $1 AND status IN ('pending', 'approved')`, [tenantId])).rowCount) throw new AppError(409, 'There is already a proposal waiting. Decide it, or have it rejected, first.');
  if (e.rollbackOf && !(await c.query('SELECT 1 FROM policy_versions WHERE id = $1 AND tenant_id = $2', [e.rollbackOf, tenantId])).rowCount) throw new AppError(404, 'The version to go back to was not found.');
  const live = await livePolicy(c, tenantId);
  const change = classifyPolicyChange(live?.rules ?? null, rules);
  if (change === 'none') throw new AppError(400, 'That is the policy already in force.');
  const top = (await c.query('SELECT major, minor FROM policy_versions WHERE tenant_id = $1 ORDER BY major DESC, minor DESC LIMIT 1', [tenantId])).rows[0] as { major: number; minor: number } | undefined;
  const next = !top ? { major: 1, minor: 0 } : change === 'major' ? { major: top.major + 1, minor: 0 } : { major: top.major, minor: top.minor + 1 };
  const row = (await c.query(
    `INSERT INTO policy_versions (tenant_id, major, minor, rules, summary, diff, from_version_id, rollback_of, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, next.major, next.minor, JSON.stringify(rules), e.summary, JSON.stringify(diffPolicy(live?.rules ?? null, rules)), live?.id ?? null, e.rollbackOf ?? null, actorId])).rows[0];
  await audit(c, actorId, 'policy.propose', 'policy', row.id, { version: label(next), change });
  return getVersion(c, row.id);
}

export const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional() }).strict();

/** One level decides. Levels go in order; nobody decides what they proposed, or more than one level; a refusal needs a reason and ends the proposal. */
export async function decide(c: pg.PoolClient, actorId: string, versionId: string, e: z.infer<typeof decisionSchema>) {
  const first = await getVersion(c, versionId);
  await lock(c, `policy:${first.tenantId}`);
  const v = await getVersion(c, versionId);
  if (v.status !== 'pending') throw new AppError(409, `This proposal is ${v.status}; it can no longer be decided.`);
  if (v.proposedBy === actorId) throw new AppError(403, 'You proposed this change, so you cannot decide it.');
  if ((await c.query('SELECT 1 FROM policy_approvals WHERE version_id = $1 AND decided_by = $2', [versionId, actorId])).rowCount) throw new AppError(403, 'You have already decided a level of this change. Each level needs someone else.');
  if (e.decision === 'rejected' && !e.note?.trim()) throw new AppError(400, 'Say why you are turning this down.');
  cleanNote(e.note, 'note');
  await c.query('INSERT INTO policy_approvals (version_id, level, decision, note, decided_by) VALUES ($1,$2,$3,$4,$5)', [versionId, v.nextLevel, e.decision, e.note ?? null, actorId]);
  const status = e.decision === 'rejected' ? 'rejected' : v.nextLevel + 1 >= v.progress.length ? 'approved' : 'pending';
  if (status !== 'pending') await c.query('UPDATE policy_versions SET status = $2 WHERE id = $1', [versionId, status]);
  await audit(c, actorId, 'policy.decide', 'policy', versionId, { level: v.nextLevel, decision: e.decision });
  return getVersion(c, versionId);
}

/** Put an approved policy live. Not the person who proposed it; the one it replaces is retired in the same step. */
export async function activate(c: pg.PoolClient, actorId: string, versionId: string) {
  const first = await getVersion(c, versionId);
  await lock(c, `policy:${first.tenantId}`);
  const v = await getVersion(c, versionId);
  if (v.status !== 'approved') throw new AppError(409, `This proposal is ${v.status}. It needs every level approved before it can go live.`);
  if (v.proposedBy === actorId) throw new AppError(403, 'You proposed this change, so someone else has to put it live.');
  await c.query(`UPDATE policy_versions SET status = 'retired' WHERE tenant_id = $1 AND status = 'live'`, [v.tenantId]);
  await c.query(`UPDATE policy_versions SET status = 'live', activated_by = $2, activated_at = now() WHERE id = $1`, [versionId, actorId]);
  await audit(c, actorId, 'policy.activate', 'policy', versionId, { version: v.version });
  return getVersion(c, versionId);
}

// ------------------------------------------------------------------------------------------------ asking the policy
export const checkSchema = z.object({ action: z.string().min(1).max(60), variables: z.record(z.string(), z.any()).default({}), callId: z.string().uuid().optional() }).strict();

/** May the bot do this? The live policy answers; with none live, or on any doubt, the answer is no. Every answer is kept, without the call's variables. */
export async function check(c: pg.PoolClient, tenantId: string, e: z.infer<typeof checkSchema>): Promise<Verdict & { version: string | null }> {
  if (Object.keys(e.variables).length > 100) throw new AppError(400, 'Too many variables.');
  const live = await livePolicy(c, tenantId);
  const verdict: Verdict = live ? evaluate(live.rules, e.action, e.variables as Record<string, Json> as Vars) : { allowed: false, ruleId: null, reason: 'No policy is in force, so the action is not allowed.' };
  await c.query('INSERT INTO policy_decisions (tenant_id, version_id, action, allowed, rule_id, reason, call_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [tenantId, live?.id ?? null, e.action, verdict.allowed, verdict.ruleId, verdict.reason.slice(0, 500), e.callId ?? null]);
  return { ...verdict, version: live?.label ?? null };
}

export const listDecisions = async (c: pg.PoolClient, tenantId: string, limit = 100) =>
  (await c.query('SELECT d.id, d.action, d.allowed, d.rule_id, d.reason, d.call_id, d.at, v.major, v.minor FROM policy_decisions d LEFT JOIN policy_versions v ON v.id = d.version_id WHERE d.tenant_id = $1 ORDER BY d.id DESC LIMIT $2', [tenantId, Math.min(limit, 500)]))
    .rows.map((r) => ({ id: r.id, action: r.action, allowed: r.allowed, ruleId: r.rule_id, reason: r.reason, callId: r.call_id, at: r.at, version: r.major ? `${r.major}.${r.minor}` : null }));

/** The policy in force as the call engine uses it: banned phrases to check every line against, and what to tell a model. None live, none enforced. */
export async function policyGuard(c: pg.PoolClient, tenantId: string): Promise<PolicyGuard | undefined> {
  const live = await livePolicy(c, tenantId);
  if (!live) return undefined;
  return {
    version: live.label,
    violation: (line) => phraseViolation(live.rules, line),
    mustNotSay: live.rules.flatMap((r) => (r.kind === 'must_not_say' ? r.phrases : [])),
    denied: [...new Set(live.rules.filter((r) => r.kind === 'action' && r.effect === 'deny').map((r) => (r as Extract<Rule, { kind: 'action' }>).action))],
  };
}
