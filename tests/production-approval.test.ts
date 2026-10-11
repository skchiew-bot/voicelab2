import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { withActor } from '../src/db.js';
import { createUser } from '../src/store/tenants.js';
import { deploy } from '../src/store/workflows.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

// Production is reached through an approved change, decided by a different person, except by the deployers the owner
// names in PRODUCTION_DEPLOYERS (owner's decision, 2026-10-11). Here the named deployer is Dee; the suite's usual staff
// admin is not named, so it stands for every other admin.
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let staff: string; let dee: string; let reviewer: string; let wfId: string; let v1: string; let v2: string;
const DEE = 'Dee.Deployer@DayThree.test';
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const as = (token: string) => ({ post: (u: string, b?: unknown) => env.call(token, 'POST', u, b), get: (u: string) => env.call(token, 'GET', u) });

const def = (greeting: string): WorkflowDefinition => ({
  start: 'ask', variables: [],
  nodes: {
    ask: { type: 'speak', speech: 'fixed', text: greeting, listen: { captureAs: 'a', intents: { yes: ['yes'] } }, transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
});
const scenarios = [{ name: 'yes', variables: {}, replies: ['yes'], expect: { outcome: 'ok' } }];
/** Live in staging and rehearsed there: everything production needs except the approval. */
async function ready(versionId: string) {
  await must(as(staff).post(`/internal/workflows/${wfId}/deploy`, { versionId, environment: 'staging' }));
  await must(as(staff).post(`/internal/workflows/${wfId}/simulate`, { versionId, scenarios }));
}
const live = async () => (await must(as(staff).get(`/internal/workflows/${wfId}/deployments`))).json();
const productionRows = async () => (await env.pool.query(`SELECT version_id, kind FROM workflow_deployments WHERE workflow_id = $1 AND environment = 'production' ORDER BY created_at, id`, [wfId])).rows;
const deployAudits = async () => (await env.pool.query(`SELECT action, detail FROM audit_log WHERE entity_id = $1 AND action IN ('workflow.deploy', 'workflow.rollback') AND detail->>'environment' = 'production' ORDER BY id`, [wfId])).rows;
const REFUSED = 'Putting a flow live in production needs an approved change: propose it, and a different person approves it. Only the deployers the owner has named go live directly.';

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb({ productionDeployers: [DEE.toLowerCase()] });
  staff = env.staffToken;
  const mk = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
  dee = await mk(DEE); reviewer = await mk('reviewer@daythree.test');
  const tenantId = (await must(as(staff).post('/internal/tenants', { name: 'Approval Co' }))).json().id;
  const c = (await must(as(staff).post(`/internal/tenants/${tenantId}/workflows`, { name: 'approval_flow', definition: def('Is now a good time?') }))).json();
  wfId = c.workflow.id; v1 = c.version.id;
  v2 = (await must(as(staff).post(`/internal/workflows/${wfId}/versions`, { definition: def('Is now a good time to talk?') }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

describe('putting a flow live in production', () => {
  it('is refused to an admin the owner has not named, with nothing put live; staging stays open to every admin', async () => {
    await ready(v1);
    const r = await as(staff).post(`/internal/workflows/${wfId}/deploy`, { versionId: v1, environment: 'production' });
    expect([r.statusCode, r.json().error]).toEqual([403, REFUSED]);
    expect(await productionRows()).toEqual([]);
    expect((await live()).production).toBeFalsy();
  });

  it('goes through for a named deployer, matched by email whatever its case, and the audit says why no change was needed', async () => {
    expect((await as(dee).post(`/internal/workflows/${wfId}/deploy`, { versionId: v1, environment: 'production' })).statusCode).toBe(201);
    expect(await productionRows()).toEqual([{ version_id: v1, kind: 'deploy' }]);
    expect((await deployAudits()).map((a) => a.detail.approval)).toEqual(['named deployer']);
  });

  it('goes through for anyone else as an approved change: proposed by one admin, approved by a different one', async () => {
    await ready(v2);
    const ch = (await must(as(staff).post(`/internal/workflows/${wfId}/changes`, { toVersionId: v2, environment: 'production', reason: 'A clearer question.', scenarios }))).json();
    expect((await as(staff).post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);   // not by the person who proposed it
    await must(as(reviewer).post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' }));
    await must(as(staff).post(`/internal/changes/${ch.id}/apply`));
    expect(await productionRows()).toEqual([{ version_id: v1, kind: 'deploy' }, { version_id: v2, kind: 'deploy' }]);
    expect((await deployAudits()).map((a) => a.detail.approval)).toEqual(['named deployer', 'change']);
  });

  it('holds a rollback in production to the same rule', async () => {
    const r = await as(staff).post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' });
    expect([r.statusCode, r.json().error]).toEqual([403, REFUSED]);
    expect((await productionRows()).length).toBe(2);
    expect((await as(dee).post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' })).statusCode).toBe(201);
    expect((await productionRows()).at(-1)).toEqual({ version_id: v1, kind: 'rollback' });
    expect((await deployAudits()).at(-1)).toMatchObject({ action: 'workflow.rollback', detail: { approval: 'named deployer' } });
  });

  it('is refused to a named deployer whose account is disabled, even called directly', async () => {
    const deeId = (await env.pool.query('SELECT id FROM users WHERE lower(email) = $1', [DEE.toLowerCase()])).rows[0].id as string;
    await must(as(staff).post(`/internal/users/${deeId}/disable`));
    await expect(withActor(env.pool, { kind: 'internal' }, (c) => deploy(c, deeId, wfId, { versionId: v2, environment: 'production' }, { by: 'person', deployers: [DEE.toLowerCase()] })))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('the list of named deployers', () => {
  const base = { DATABASE_URL: 'postgres://x', VOICELAB_SECRET_KEY: 'k' };
  it('is read from the setting as lower-case emails, and is empty when not set, so production then needs a change from everyone', () => {
    expect(loadConfig({ ...base, PRODUCTION_DEPLOYERS: ' Chu@DayThree.test, ops@daythree.test ,, ' }).PRODUCTION_DEPLOYERS).toEqual(['chu@daythree.test', 'ops@daythree.test']);
    expect(loadConfig({ ...base }).PRODUCTION_DEPLOYERS).toEqual([]);
    expect(loadConfig({ ...base, PRODUCTION_DEPLOYERS: '' }).PRODUCTION_DEPLOYERS).toEqual([]);
  });
});
