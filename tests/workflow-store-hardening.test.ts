import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKey } from '../src/secrets.js';
import { replyRun } from '../src/store/runs.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string;
const st = () => env.staffToken;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const get = (url: string) => env.call(st(), 'GET', url);
const post = (url: string, body?: unknown) => env.call(st(), 'POST', url, body);

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Hardening Co' }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

// Findings from the independent review of Phase 2 that live in the database layer.
const create = async (name: string, def: WorkflowDefinition) => (await must(post(`/internal/tenants/${tenantId}/workflows`, { name, definition: def }))).json() as
  { workflow: { id: string }; version: { id: string } };
const save = (wfId: string, def: WorkflowDefinition) => post(`/internal/workflows/${wfId}/versions`, { definition: def });
const deploy = (wfId: string, versionId: string, environment: string) => post(`/internal/workflows/${wfId}/deploy`, { versionId, environment });
const simulate = (wfId: string, scenarios: unknown[]) => post(`/internal/workflows/${wfId}/simulate`, { scenarios });

const asker = (): WorkflowDefinition => ({
  start: 'ask', variables: ['ic'], sensitiveVariables: ['ic'],
  nodes: { ask: { type: 'speak', speech: 'fixed', text: 'Is that right?', listen: { captureAs: 'answer' }, transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'finished' } },
});
const startWaiting = async (name: string) => {
  const { workflow, version } = await create(name, asker());
  await must(deploy(workflow.id, version.id, 'staging'));
  const run = (await must(post(`/internal/workflows/${workflow.id}/runs`, { environment: 'staging', variables: { ic: '900101145678' } }))).json();
  return { workflow, run };
};

describe('a sensitive value is not kept readable while a call waits', () => {
  it('is sealed in the database, hidden in every view, and still available when the call resumes', async () => {
    const { run } = await startWaiting('waiting');
    expect(run.status).toBe('awaiting_reply');
    expect(JSON.stringify(run)).not.toContain('900101145678');
    const row = (await env.pool.query('SELECT state, sealed FROM workflow_runs WHERE id = $1', [run.id])).rows[0];
    expect(JSON.stringify(row.state)).not.toContain('900101145678');
    expect(row.sealed).not.toBeNull();
    expect(row.sealed.includes(Buffer.from('900101145678'))).toBe(false);
    expect(JSON.stringify((await get(`/internal/workflow-runs/${run.id}`)).json())).not.toContain('900101145678');
    const done = (await must(post(`/internal/workflow-runs/${run.id}/reply`, { text: 'yes' }))).json();
    expect(done).toMatchObject({ status: 'ended', outcome: 'finished' });
    const after = (await env.pool.query('SELECT state, sealed FROM workflow_runs WHERE id = $1', [run.id])).rows[0];
    expect(after.sealed).toBeNull();
    expect(JSON.stringify(after.state)).not.toContain('900101145678');
  });

  it('is wiped from calls left waiting, by the sweep, and only from stale ones', async () => {
    const stale = (await startWaiting('stale')).run;
    const fresh = (await startWaiting('fresh')).run;
    await env.pool.query(`UPDATE workflow_runs SET updated_at = now() - interval '3 hours' WHERE id = $1`, [stale.id]);
    expect((await post('/internal/workflow-runs/sweep', { olderThanMinutes: 60 })).json()).toEqual({ abandoned: 1 });
    const rows = (await env.pool.query('SELECT id, status, outcome, sealed FROM workflow_runs WHERE id = ANY($1)', [[stale.id, fresh.id]])).rows;
    expect(rows.find((r) => r.id === stale.id)).toMatchObject({ status: 'ended', outcome: 'abandoned', sealed: null });
    expect(rows.find((r) => r.id === fresh.id)).toMatchObject({ status: 'awaiting_reply' });
    expect((await post(`/internal/workflow-runs/${stale.id}/reply`, { text: 'yes' })).statusCode).toBe(409);
  });
});

describe('a reply is claimed before it is applied', () => {
  it('lets only one of two simultaneous replies through', async () => {
    const { run } = await startWaiting('claim');
    const rs = await Promise.all([post(`/internal/workflow-runs/${run.id}/reply`, { text: 'yes' }), post(`/internal/workflow-runs/${run.id}/reply`, { text: 'yes' })]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const steps = (await env.pool.query(`SELECT count(*)::int AS n FROM workflow_run_steps WHERE run_id = $1 AND type = 'heard'`, [run.id])).rows[0].n;
    expect(steps).toBe(1);
  });
  it('does the work of a turn once: two simultaneous replies cannot both reach the next step\'s side effects', async () => {
    const def: WorkflowDefinition = { start: 'ask', nodes: {
      ask: { type: 'speak', speech: 'fixed', text: 'Ready?', listen: { captureAs: 'answer' }, transitions: [{ to: 'write' }] },
      write: { type: 'speak', speech: 'dynamic', prompt: 'Say thanks', text: 'Thanks', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const { workflow, version } = await create('claim_effects', def);
    await must(deploy(workflow.id, version.id, 'staging'));
    const run = (await must(post(`/internal/workflows/${workflow.id}/runs`, { environment: 'staging' }))).json();
    let calls = 0;
    const speaker = { generate: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return 'Thanks'; } };
    const deps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker };
    const results = await Promise.allSettled([replyRun(deps, run.id, 'yes'), replyRun(deps, run.id, 'yes')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(calls).toBe(1);
  });
  it('refuses a reply while another is being applied', async () => {
    const { run } = await startWaiting('claimed');
    await env.pool.query(`UPDATE workflow_runs SET status = 'processing' WHERE id = $1`, [run.id]);
    const r = await post(`/internal/workflow-runs/${run.id}/reply`, { text: 'yes' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('already being applied');
  });
});

describe('replacing a workflow cannot break the ones that use it', () => {
  const child = (extraVar = false): WorkflowDefinition => ({
    start: 'a', variables: extraVar ? ['name', 'extra'] : ['name'],
    nodes: { a: { type: 'speak', speech: 'hybrid', text: extraVar ? 'Hi {{name}} {{extra}}' : 'Hi {{name}}', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } },
  });
  const parent = (): WorkflowDefinition => ({ start: 's', variables: ['name'], nodes: { s: { type: 'subflow', workflow: 'dep_child', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } });

  it('refuses to deploy a new version of a dependency that needs what its live callers do not provide', async () => {
    const c = await create('dep_child', child()); const p = await create('dep_parent', parent());
    await must(deploy(c.workflow.id, c.version.id, 'staging')); await must(deploy(p.workflow.id, p.version.id, 'staging'));
    const v2 = (await must(save(c.workflow.id, child(true)))).json();
    const r = await deploy(c.workflow.id, v2.id, 'staging');
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).toContain('dep_parent');
    expect(JSON.stringify(r.json())).toContain('extra');
  });
  it('refuses a rollback that would do the same', async () => {
    const c = await create('rb_child', child(true));
    const call = (vars: string[]): WorkflowDefinition => ({ start: 's', variables: vars, nodes: { s: { type: 'subflow', workflow: 'rb_child', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } });
    const p = await create('rb_parent', call(['name', 'extra']));
    await must(deploy(c.workflow.id, c.version.id, 'staging'));
    await must(deploy(p.workflow.id, p.version.id, 'staging'));
    // the child stops needing "extra", and the parent stops supplying it
    const c2 = (await must(save(c.workflow.id, child()))).json();
    await must(deploy(c.workflow.id, c2.id, 'staging'));
    const p2 = (await must(save(p.workflow.id, call(['name'])))).json();
    await must(deploy(p.workflow.id, p2.id, 'staging'));
    // going back to the child that needs "extra" would leave the parent unable to run it
    const r = await post(`/internal/workflows/${c.workflow.id}/rollback`, { environment: 'staging' });
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).toContain('rb_parent');
  });
});

describe('the production gate', () => {
  const wf = (text = 'Hi'): WorkflowDefinition => ({ start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text, transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } });

  it('does not count a simulation that asserts nothing, or one that expects a failure', async () => {
    const { workflow, version } = await create('gate_a', wf());
    await must(deploy(workflow.id, version.id, 'staging'));
    const weak = (await must(simulate(workflow.id, [{ name: 'no expectation', variables: {} }]))).json();
    expect(weak).toMatchObject({ passed: 1, failed: 0, clean: false });
    expect(weak.gateProblems[0]).toContain('no expectation');
    const r = await deploy(workflow.id, version.id, 'production');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('expected outcome');
    const strong = (await must(simulate(workflow.id, [{ name: 'ends ok', variables: {}, expect: { outcome: 'ok' } }]))).json();
    expect(strong.clean).toBe(true);
    expect((await deploy(workflow.id, version.id, 'production')).statusCode).toBe(201);
  });

  it('requires what runs in production to be what was simulated', async () => {
    const c = await create('gate_child', wf()); const p = await create('gate_parent', { start: 's', nodes: { s: { type: 'subflow', workflow: 'gate_child', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } });
    await must(deploy(c.workflow.id, c.version.id, 'staging'));
    await must(simulate(c.workflow.id, [{ name: 'ok', variables: {}, expect: { outcome: 'ok' } }]));
    await must(deploy(c.workflow.id, c.version.id, 'production'));
    await must(deploy(p.workflow.id, p.version.id, 'staging'));
    await must(simulate(p.workflow.id, [{ name: 'ok', variables: {}, expect: { outcome: 'ok' } }]));
    // the child moves on in both environments after the parent was simulated
    const v2 = (await must(save(c.workflow.id, wf('Hello again')))).json();
    await must(deploy(c.workflow.id, v2.id, 'staging'));
    await must(simulate(c.workflow.id, [{ name: 'ok', variables: {}, expect: { outcome: 'ok' } }]));
    await must(deploy(c.workflow.id, v2.id, 'production'));
    const r = await deploy(p.workflow.id, p.version.id, 'production');
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify(r.json())).toContain('gate_child');
    await must(simulate(p.workflow.id, [{ name: 'ok', variables: {}, expect: { outcome: 'ok' } }]));
    expect((await deploy(p.workflow.id, p.version.id, 'production')).statusCode).toBe(201);
  });
});

describe('integration keys', () => {
  it('cannot hold a line break, which would let a key add headers to the request', async () => {
    const r = await post(`/internal/tenants/${tenantId}/integrations`, { name: 'crlf', baseUrl: 'https://ok.example.test', authHeader: 'X-Key', authSecret: 'abc\r\nX-Evil: 1' });
    expect(r.statusCode).toBe(400);
  });
});
