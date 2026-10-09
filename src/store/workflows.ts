import type pg from 'pg';
import { AppError } from '../errors.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { checkReferences, isWorkflowName } from '../workflows/refs.js';
import { validateDefinition, type ValidationResult } from '../workflows/validate.js';
import { classifyChange, nextVersion, versionLabel, type Change } from '../workflows/versioning.js';
import { audit } from './audit.js';

export type Environment = 'staging' | 'production';

export interface VersionRow {
  id: string; workflow_id: string; major: number; minor: number; change: string; definition: WorkflowDefinition;
  valid: boolean; issues: ValidationResult; note: string | null; created_at: Date;
}
const present = (v: VersionRow) => ({ ...v, version: versionLabel(v) });

export async function createWorkflow(
  c: pg.PoolClient, actorId: string | null, e: { tenantId: string; name: string; definition: unknown; note?: string },
) {
  if (!isWorkflowName(e.name)) throw new AppError(400, 'A workflow name starts with a letter and uses letters, digits, - and _ (up to 64 characters).');
  const wf = (await c.query('INSERT INTO workflows (tenant_id, name) VALUES ($1,$2) RETURNING id, tenant_id, name, created_at', [e.tenantId, e.name])).rows[0];
  const version = await insertVersion(c, actorId, wf.id, e.definition, 'initial', { major: 1, minor: 0 }, e.note);
  await audit(c, actorId, 'workflow.create', 'workflow', wf.id, { name: e.name });
  return { workflow: wf, version: present(version) };
}

async function insertVersion(
  c: pg.PoolClient, actorId: string | null, workflowId: string, definition: unknown,
  change: 'initial' | 'minor' | 'major', n: { major: number; minor: number }, note?: string,
): Promise<VersionRow> {
  const issues = validateDefinition(definition);
  return (await c.query(
    `INSERT INTO workflow_versions (workflow_id, major, minor, change, definition, valid, issues, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [workflowId, n.major, n.minor, change, JSON.stringify(definition), issues.errors.length === 0, JSON.stringify(issues), note ?? null, actorId],
  )).rows[0];
}

const latestVersion = async (c: pg.PoolClient, workflowId: string): Promise<VersionRow | undefined> =>
  (await c.query('SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY major DESC, minor DESC LIMIT 1', [workflowId])).rows[0];

function classify(prev: unknown, next: unknown): Change {
  try { return classifyChange(prev as WorkflowDefinition, next as WorkflowDefinition); } catch { return 'major'; } // a malformed definition has no comparable shape
}

/** Save a new version. The number follows the change: inside nodes is minor, a change of shape is major. */
export async function saveVersion(c: pg.PoolClient, actorId: string | null, workflowId: string, e: { definition: unknown; note?: string }) {
  // Lock the workflow so two saves cannot take the same number.
  if (!(await c.query('SELECT id FROM workflows WHERE id = $1 FOR UPDATE', [workflowId])).rows[0]) throw new AppError(404, 'Workflow not found.');
  const prev = (await latestVersion(c, workflowId))!;
  const change = classify(prev.definition, e.definition);
  if (change === 'none') throw new AppError(409, `That is the same as version ${versionLabel(prev)}: nothing to save.`);
  const v = await insertVersion(c, actorId, workflowId, e.definition, change, nextVersion(prev, change), e.note);
  await audit(c, actorId, 'workflow.version', 'workflow', workflowId, { version: versionLabel(v), change });
  return present(v);
}

export const listVersions = async (c: pg.PoolClient, workflowId: string) =>
  (await c.query('SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY major DESC, minor DESC', [workflowId])).rows.map(present);

export async function getVersion(c: pg.PoolClient, versionId: string) {
  const v = (await c.query('SELECT * FROM workflow_versions WHERE id = $1', [versionId])).rows[0];
  if (!v) throw new AppError(404, 'Version not found.');
  return present(v);
}

export const listWorkflows = async (c: pg.PoolClient, tenantId?: string) =>
  (await c.query(
    `SELECT w.id, w.tenant_id, w.name, w.created_at,
            (SELECT major || '.' || minor FROM workflow_versions v WHERE v.workflow_id = w.id ORDER BY major DESC, minor DESC LIMIT 1) AS latest_version,
            (SELECT v.major || '.' || v.minor FROM workflow_deployments d JOIN workflow_versions v ON v.id = d.version_id
              WHERE d.workflow_id = w.id AND d.environment = 'staging' ORDER BY d.id DESC LIMIT 1) AS staging_version,
            (SELECT v.major || '.' || v.minor FROM workflow_deployments d JOIN workflow_versions v ON v.id = d.version_id
              WHERE d.workflow_id = w.id AND d.environment = 'production' ORDER BY d.id DESC LIMIT 1) AS production_version
       FROM workflows w WHERE ($1::uuid IS NULL OR w.tenant_id = $1) ORDER BY w.name`, [tenantId ?? null])).rows;

export async function getWorkflow(c: pg.PoolClient, workflowId: string) {
  const w = (await c.query('SELECT id, tenant_id, name, created_at FROM workflows WHERE id = $1', [workflowId])).rows[0];
  if (!w) throw new AppError(404, 'Workflow not found.');
  return w as { id: string; tenant_id: string; name: string; created_at: Date };
}

// ---------------------------------------------------------------- deployments
interface DeploymentRow { id: number; workflow_id: string; environment: Environment; version_id: string; kind: 'deploy' | 'rollback'; created_at: Date }

/**
 * The versions an environment has had live, oldest first, with a rollback taking the newest one off. The
 * last entry is what is live now; the one before it is what a rollback goes back to. Rolling back twice
 * therefore goes back two versions, rather than flipping between the same two.
 */
export function liveStack(rows: Pick<DeploymentRow, 'kind' | 'version_id'>[]): string[] {
  const stack: string[] = [];
  for (const r of rows) {
    if (r.kind === 'rollback') stack.pop();
    else if (stack[stack.length - 1] !== r.version_id) stack.push(r.version_id);
  }
  return stack;
}

const history = async (c: pg.PoolClient, workflowId: string, env: Environment): Promise<DeploymentRow[]> =>
  (await c.query('SELECT * FROM workflow_deployments WHERE workflow_id = $1 AND environment = $2 ORDER BY id', [workflowId, env])).rows;

export async function liveVersionId(c: pg.PoolClient, workflowId: string, env: Environment): Promise<string | undefined> {
  const stack = liveStack(await history(c, workflowId, env));
  return stack[stack.length - 1];
}

/** The definition live in an environment, for every workflow of a tenant, by name. */
async function liveDefinitions(c: pg.PoolClient, tenantId: string, env: Environment) {
  const names = new Set((await c.query('SELECT name FROM workflows WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.name as string));
  const live = new Map<string, WorkflowDefinition>();
  for (const w of (await c.query('SELECT id, name FROM workflows WHERE tenant_id = $1', [tenantId])).rows) {
    const id = await liveVersionId(c, w.id, env);
    if (id) live.set(w.name, (await c.query('SELECT definition FROM workflow_versions WHERE id = $1', [id])).rows[0].definition);
  }
  return { names, live };
}

async function referenceProblems(c: pg.PoolClient, wf: { tenant_id: string; name: string }, def: WorkflowDefinition, env: Environment) {
  const { names, live } = await liveDefinitions(c, wf.tenant_id, env);
  return checkReferences(wf.name, def, (name) => (name === wf.name ? def : live.get(name) ?? (names.has(name) ? 'undeployed' : 'absent')));
}

/**
 * Put a version live. It must be free of errors, and every workflow it hands over to must be live in the same
 * environment and get the variables it needs. Production also needs the version to be live in staging and to
 * have passed a simulation there.
 */
export async function deploy(c: pg.PoolClient, actorId: string | null, workflowId: string, e: { versionId: string; environment: Environment }) {
  await c.query('SELECT id FROM workflows WHERE id = $1 FOR UPDATE', [workflowId]);
  const wf = await getWorkflow(c, workflowId);
  const version = (await c.query('SELECT * FROM workflow_versions WHERE id = $1 AND workflow_id = $2', [e.versionId, workflowId])).rows[0] as VersionRow | undefined;
  if (!version) throw new AppError(404, 'That version does not belong to this workflow.');
  const label = versionLabel(version);

  if (!version.valid) {
    throw new AppError(400, `Version ${label} cannot be published: it has ${version.issues.errors.length} error${version.issues.errors.length === 1 ? '' : 's'}.`, version.issues.errors.map((x) => (x.nodeId ? `${x.nodeId}: ` : '') + x.message));
  }
  const refs = await referenceProblems(c, wf, version.definition, e.environment);
  if (refs.length) throw new AppError(400, `Version ${label} cannot go live in ${e.environment}: it depends on workflows that are not ready.`, refs.map((r) => r.message));

  const stack = liveStack(await history(c, workflowId, e.environment));
  if (stack[stack.length - 1] === version.id) throw new AppError(409, `Version ${label} is already live in ${e.environment}.`);

  if (e.environment === 'production') {
    const inStaging = await liveVersionId(c, workflowId, 'staging');
    if (inStaging !== version.id) throw new AppError(409, `Version ${label} is not live in staging. Deploy it to staging and simulate it there first.`);
    const clean = (await c.query('SELECT 1 FROM simulation_batches WHERE version_id = $1 AND failed = 0 AND total > 0 LIMIT 1', [version.id])).rowCount === 1;
    if (!clean) throw new AppError(409, `Version ${label} has no clean simulation. Run a list-based simulation of it in staging and make every scenario pass.`);
  }

  const d = (await c.query(
    `INSERT INTO workflow_deployments (workflow_id, environment, version_id, kind, deployed_by) VALUES ($1,$2,$3,'deploy',$4) RETURNING *`,
    [workflowId, e.environment, version.id, actorId])).rows[0];
  await audit(c, actorId, 'workflow.deploy', 'workflow', workflowId, { version: label, environment: e.environment });
  return { ...d, version: label };
}

/** Go back to the version that was live before the current one. Calls already under way keep the version they started on. */
export async function rollback(c: pg.PoolClient, actorId: string | null, workflowId: string, environment: Environment) {
  await c.query('SELECT id FROM workflows WHERE id = $1 FOR UPDATE', [workflowId]);
  const wf = await getWorkflow(c, workflowId);
  const stack = liveStack(await history(c, workflowId, environment));
  if (stack.length < 2) throw new AppError(409, `There is no earlier version to go back to in ${environment}.`);
  const target = (await c.query('SELECT * FROM workflow_versions WHERE id = $1', [stack[stack.length - 2]])).rows[0] as VersionRow;
  const refs = await referenceProblems(c, wf, target.definition, environment);
  if (refs.length) throw new AppError(409, `Version ${versionLabel(target)} cannot be restored: it depends on workflows that are no longer ready.`, refs.map((r) => r.message));
  const d = (await c.query(
    `INSERT INTO workflow_deployments (workflow_id, environment, version_id, kind, deployed_by) VALUES ($1,$2,$3,'rollback',$4) RETURNING *`,
    [workflowId, environment, target.id, actorId])).rows[0];
  await audit(c, actorId, 'workflow.rollback', 'workflow', workflowId, { to: versionLabel(target), environment });
  return { ...d, version: versionLabel(target) };
}

export async function deployments(c: pg.PoolClient, workflowId: string) {
  const rows = (await c.query(
    `SELECT d.id, d.environment, d.kind, d.created_at, v.id AS version_id, v.major, v.minor
       FROM workflow_deployments d JOIN workflow_versions v ON v.id = d.version_id WHERE d.workflow_id = $1 ORDER BY d.id DESC`, [workflowId])).rows;
  const live: Record<string, string | null> = { staging: null, production: null };
  // What a rollback would go back to, per environment.
  const previous: Record<string, string | null> = { staging: null, production: null };
  const label = (id: string | undefined) => { const row = rows.find((r) => r.version_id === id); return row ? `${row.major}.${row.minor}` : null; };
  for (const env of ['staging', 'production'] as const) {
    const stack = liveStack(await history(c, workflowId, env));
    live[env] = label(stack[stack.length - 1]);
    previous[env] = label(stack[stack.length - 2]);
  }
  return { live, previous, history: rows.map((r) => ({ id: r.id, environment: r.environment, kind: r.kind, version: `${r.major}.${r.minor}`, created_at: r.created_at })) };
}
