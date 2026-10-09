import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

// ------------------------------------------------------------------ the template, staging to production
describe('exit criterion: the debt-collection template runs end to end in staging and then in production', () => {
  let env: Env; let tenantId: string; let ids: Record<string, { id: string; versionId: string }>;
  const st = () => env.staffToken;
  const get = (u: string) => env.call(st(), 'GET', u);
  const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
  const contact = { customer_name: 'Aisha binti Ahmad', company: 'Acme Finance', balance: '1250.50', account_name: 'Personal Loan', due_date: '1 September 2026', payment_channel: 'online banking', expected_nric_last4: '4521' };

  beforeAll(async () => {
    env = await (await import('./helpers.js')).setupDb();
    tenantId = (await must(post('/internal/tenants', { name: 'Collections Co' }))).json().id;
  });
  afterAll(async () => { await env?.teardown(); });

  it('is offered as a template, and creates all four workflows, valid, as version 1.0', async () => {
    const list = (await get('/internal/workflow-templates')).json();
    expect(list.find((t: { key: string }) => t.key === 'debt_collection_my')).toMatchObject({ title: 'Debt collection (Malaysia)', entry: 'collections' });
    expect((await post(`/internal/tenants/${tenantId}/workflows/from-template`, { template: 'nope' })).statusCode).toBe(404);
    const made = (await must(post(`/internal/tenants/${tenantId}/workflows/from-template`, { template: 'debt_collection_my' }))).json();
    expect(made.entry).toBe('collections');
    expect(made.workflows.map((w: { name: string }) => w.name).sort()).toEqual(['collections', 'human_transfer', 'partial_payment', 'verify_identity']);
    expect(made.workflows.every((w: { valid: boolean; version: string }) => w.valid && w.version === '1.0')).toBe(true);
    ids = Object.fromEntries(made.workflows.map((w: { name: string; id: string; versionId: string }) => [w.name, { id: w.id, versionId: w.versionId }]));
    // creating it twice for one client is refused, whole, not half done
    expect((await post(`/internal/tenants/${tenantId}/workflows/from-template`, { template: 'debt_collection_my' })).statusCode).toBe(409);
    expect((await get(`/internal/workflows?tenantId=${tenantId}`)).json()).toHaveLength(4);
  });

  const dep = (name: string, environment: string) => post(`/internal/workflows/${ids[name]!.id}/deploy`, { versionId: ids[name]!.versionId, environment });
  const sim = (name: string, scenarios: unknown[]) => post(`/internal/workflows/${ids[name]!.id}/simulate`, { scenarios });
  const scenarios = {
    collections: [
      { name: 'promises to pay', variables: contact, replies: ['Yes, speaking', '4521', 'Yes I can pay today'], expect: { outcome: 'promise_to_pay', says: ['RM 1250.50'], doesNotSay: ['4521'] } },
      { name: 'in Bahasa Malaysia', variables: { ...contact, lang: 'ms' }, replies: ['Ya betul', '4521', 'boleh'], expect: { outcome: 'promise_to_pay', says: ['baki tertunggak'] } },
      { name: 'wrong person', variables: contact, replies: ['No, wrong number'], expect: { outcome: 'wrong_person', doesNotSay: ['RM'] } },
      { name: 'fails the identity check', variables: contact, replies: ['yes', '1111', '2222'], expect: { outcome: 'verification_failed', doesNotSay: ['balance'] } },
      { name: 'can pay only part', variables: contact, replies: ['yes', '4521', 'only some of it', '200'], expect: { outcome: 'partial_agreed', handoff: 'partial_payment' } },
      { name: 'disputes', variables: contact, replies: ['yes', '4521', 'I dispute this'], expect: { outcome: 'handoff_human', handoff: 'human_transfer' } },
    ],
    verify_identity: [{ name: 'matches', variables: { expected_nric_last4: '4521' }, replies: ['4521'], expect: { outcome: 'verified' } }, { name: 'does not', variables: { expected_nric_last4: '4521' }, replies: ['1', '2'], expect: { outcome: 'failed' } }],
    partial_payment: [{ name: 'gives an amount', variables: { customer_name: 'A', balance: '10' }, replies: ['50'], expect: { outcome: 'partial_agreed' } }],
    human_transfer: [{ name: 'passes over', variables: {}, expect: { outcome: 'handoff_human' } }],
  };

  it('goes to staging only after the workflows it depends on, and every simulation passes', async () => {
    const early = await dep('collections', 'staging');
    expect(early.statusCode).toBe(400);
    expect((early.json().details as string[]).join(' ')).toContain('not deployed there yet');
    for (const name of ['verify_identity', 'partial_payment', 'human_transfer', 'collections']) expect((await dep(name, 'staging')).statusCode, name).toBe(201);
    for (const [name, list] of Object.entries(scenarios)) {
      const out = (await must(sim(name, list))).json();
      expect(out.failed, `${name}: ${JSON.stringify(out.results.filter((r: { passed: boolean }) => !r.passed))}`).toBe(0);
    }
  });

  it('goes to production the same way: dependencies first', async () => {
    const early = await dep('collections', 'production');
    expect(early.statusCode).toBe(400);
    for (const name of ['verify_identity', 'partial_payment', 'human_transfer', 'collections']) expect((await dep(name, 'production')).statusCode, name).toBe(201);
    for (const name of Object.keys(ids)) expect((await get(`/internal/workflows/${ids[name]!.id}/deployments`)).json().live).toEqual({ staging: '1.0', production: '1.0' });
  });

  it('then handles a real call in production from the first word to the outcome', async () => {
    const start = (await must(post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'production', kind: 'live', variables: contact }))).json();
    expect(start).toMatchObject({ status: 'awaiting_reply', awaiting: { captureAs: 'is_customer' } });
    expect(start.said[0]).toBe('Hello, this is Acme Finance calling for Aisha binti Ahmad. Am I speaking with Aisha binti Ahmad?');
    const say = async (text: string) => (await must(post(`/internal/workflow-runs/${start.id}/reply`, { text }))).json();
    await say('Yes, this is she');
    const disclosed = await say('4521');
    expect(disclosed.said.join(' ')).toContain('outstanding balance of RM 1250.50');
    const end = await say('Yes I can pay today');
    expect(end).toMatchObject({ status: 'ended', outcome: 'promise_to_pay' });
    expect(end.said[0]).toContain('pay through online banking');
    // everything was recorded for replay, and the identity digits are nowhere
    const run = (await get(`/internal/workflow-runs/${start.id}`)).json();
    expect(run).toMatchObject({ kind: 'live', environment: 'production', status: 'ended', outcome: 'promise_to_pay' });
    expect(run.steps.map((s: { seq: number }) => s.seq)).toEqual(run.steps.map((_: unknown, i: number) => i + 1));
    expect(run.steps.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(['say', 'heard', 'subflow_enter', 'subflow_exit', 'end']));
    const stored = await env.pool.query(`SELECT (SELECT state::text FROM workflow_runs WHERE id = $1) AS state,
                                                (SELECT string_agg(payload::text, ' ') FROM workflow_run_steps WHERE run_id = $1) AS steps`, [start.id]);
    expect(stored.rows[0].state).not.toContain('4521');
    expect(stored.rows[0].steps).not.toContain('4521');
    const everywhere = await env.pool.query(`SELECT count(*)::int AS n FROM workflow_runs WHERE state::text LIKE '%4521%' AND status = 'ended'`);
    expect(everywhere.rows[0].n).toBe(0);
    expect((await get(`/internal/workflows/${ids.collections!.id}/runs`)).json()[0]).toMatchObject({ id: start.id, environment: 'production', status: 'ended' });
  });

  it('refuses a customer record that carries a phone number', async () => {
    const r = await post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'production', kind: 'live', variables: { ...contact, phone: '+60 12-345 6789' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('never kept');
  });

  it('applies simultaneous replies one at a time, never twice and never out of order', async () => {
    const start = (await must(post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'production', kind: 'live', variables: contact }))).json();
    const rs = await Promise.all([1, 2, 3].map(() => post(`/internal/workflow-runs/${start.id}/reply`, { text: 'yes' })));
    const applied = rs.filter((r) => r.statusCode === 200).length;
    expect(rs.every((r) => [200, 409].includes(r.statusCode))).toBe(true);
    const run = (await get(`/internal/workflow-runs/${start.id}`)).json();
    expect(run.steps.filter((s: { type: string }) => s.type === 'heard')).toHaveLength(applied); // every accepted reply, and only those, is recorded
    expect(new Set(run.steps.map((s: { seq: number }) => s.seq)).size).toBe(run.steps.length);
  });

  it('applies a reply to the question it answers, or not at all', async () => {
    const start = (await must(post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'production', kind: 'live', variables: contact }))).json();
    expect(start.version).toBe(0);
    // the same answer sent three times, each saying it answers question 0: only the first can be right
    const rs = await Promise.all([1, 2, 3].map(() => post(`/internal/workflow-runs/${start.id}/reply`, { text: 'yes', expectedVersion: 0 })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const ok = rs.find((r) => r.statusCode === 200)!.json();
    expect(ok.version).toBe(1);
    // a late reply to an old question is refused, and one for the current question is accepted
    expect((await post(`/internal/workflow-runs/${start.id}/reply`, { text: '4521', expectedVersion: 0 })).statusCode).toBe(409);
    const next = await post(`/internal/workflow-runs/${start.id}/reply`, { text: '4521', expectedVersion: 1 });
    expect(next.statusCode).toBe(200);
    expect(next.json().version).toBe(2);
    expect(next.json().said.join(' ')).toContain('outstanding balance');
  });

  it('refuses a reply to a call that has ended, an unknown call, and an oversized reply', async () => {
    const done = (await must(post(`/internal/workflows/${ids.human_transfer!.id}/runs`, { environment: 'production', kind: 'live' }))).json();
    expect(done.status).toBe('ended');
    expect((await post(`/internal/workflow-runs/${done.id}/reply`, { text: 'hello' })).statusCode).toBe(409);
    expect((await post('/internal/workflow-runs/00000000-0000-4000-8000-000000000000/reply', { text: 'hello' })).statusCode).toBe(404);
    const live = (await must(post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'production', kind: 'live', variables: contact }))).json();
    expect((await post(`/internal/workflow-runs/${live.id}/reply`, { text: 'x'.repeat(2001) })).statusCode).toBe(400);
  });

  it('keeps live calls to production, and a test call to what is live where it runs', async () => {
    expect((await post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'staging', kind: 'live', variables: contact })).statusCode).toBe(400);
    const test = await post(`/internal/workflows/${ids.collections!.id}/runs`, { environment: 'staging', kind: 'test', variables: contact });
    expect(test.statusCode).toBe(201);
    expect(test.json().status).toBe('awaiting_reply');
  });

  it('is out of reach of clients', async () => {
    const user = (await must(post(`/internal/tenants/${tenantId}/users`, { email: 'c@flow.test', role: 'tenant_admin' }))).json();
    for (const [m, u] of [['GET', '/internal/workflows'], ['GET', '/internal/workflow-templates'], ['POST', `/internal/tenants/${tenantId}/workflows/from-template`], ['GET', `/internal/tenants/${tenantId}/integrations`]] as const) {
      expect((await env.call(user.token, m, u, m === 'POST' ? { template: 'debt_collection_my' } : undefined)).statusCode, u).toBe(403);
    }
    const asClient = (sql: string) => withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query(sql));
    for (const t of ['workflows', 'workflow_versions', 'workflow_deployments', 'workflow_runs', 'workflow_run_steps', 'simulation_batches', 'integrations']) {
      await expect(asClient(`SELECT * FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });
});

// ---------------------------------------------------------------------------------- integrations
describe('integrations: calling a client\'s own system mid-call', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vl-int-'));
  let server: https.Server; let env: Env; let tenantId: string; let wfId: string;
  const seen: { method: string; url: string; auth?: string; body: string }[] = [];
  const toLoopback = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as never;
  const st = () => env.staffToken;
  const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
  const get = (u: string) => env.call(st(), 'GET', u);

  beforeAll(async () => {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 2 -subj "/CN=billing.example.test" -addext "subjectAltName=DNS:billing.example.test" 2>/dev/null`);
    const cert = readFileSync(`${dir}/c.pem`, 'utf8');
    server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert }, (req, res) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers['x-api-key'] as string | undefined, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { paid: false, owing: '350.00' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    env = await (await import('./helpers.js')).setupDb({ integrationHttp: { lookup: toLoopback, ca: cert, port } });
    tenantId = (await must(post('/internal/tenants', { name: 'Integ Co' }))).json().id;
  });
  afterAll(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); await env?.teardown(); });

  it('saves the address and key, returns no key, and stores it encrypted', async () => {
    const res = await must(post(`/internal/tenants/${tenantId}/integrations`, { name: 'billing', baseUrl: 'https://billing.example.test/v1', authHeader: 'X-API-Key', authSecret: 'super-secret-key' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'billing', key_stored: true });
    expect(res.body).not.toContain('super-secret-key');
    expect(JSON.stringify((await get(`/internal/tenants/${tenantId}/integrations`)).json())).not.toContain('super-secret');
    const raw = await env.pool.query('SELECT auth_secret FROM integrations WHERE name = $1', ['billing']);
    expect(raw.rows[0].auth_secret.includes(Buffer.from('super-secret-key'))).toBe(false);
    const audit = JSON.stringify((await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'integration.create'`)).rows);
    expect(audit).not.toContain('super-secret');
    expect(audit).toContain('billing.example.test');
  });

  it('refuses addresses that point inside our own network, and a key header that could break the request', async () => {
    const bad = (body: object) => post(`/internal/tenants/${tenantId}/integrations`, { name: `x${Math.floor(Math.random() * 1e9)}`, ...body });
    for (const baseUrl of ['http://billing.example.test', 'https://169.254.169.254/latest', 'https://127.0.0.1', 'https://localhost', 'https://metadata.google.internal', 'https://user:pw@billing.example.test', 'https://billing.example.test:8443']) {
      expect((await bad({ baseUrl })).statusCode, baseUrl).toBe(400);
    }
    expect((await bad({ baseUrl: 'https://ok.example.test', authHeader: 'Host', authSecret: 'x' })).statusCode).toBe(400);
    expect((await bad({ baseUrl: 'https://ok.example.test', authHeader: 'X-Key' })).statusCode).toBe(400);
    expect((await post(`/internal/tenants/${tenantId}/integrations`, { name: 'billing', baseUrl: 'https://other.example.test' })).statusCode).toBe(409);
  });

  const withApi = (): unknown => ({
    start: 'look', variables: ['account'], nodes: {
      look: { type: 'api', integration: 'billing', path: '/accounts/{{account}}/status', store: { paid: 'data.paid', owing: 'data.owing' }, onError: 'oops', transitions: [{ to: 'tell' }] },
      tell: { type: 'speak', speech: 'hybrid', text: 'You owe RM {{owing}}.', transitions: [{ to: 'pay' }] },
      pay: { type: 'api', integration: 'billing', method: 'POST', path: '/promises', body: { account: '{{account}}', amount: '{{owing}}' }, onError: 'oops', transitions: [{ to: 'fin' }] },
      fin: { type: 'end', outcome: 'promise_recorded' }, oops: { type: 'end', outcome: 'lookup_failed' },
    } });

  it('reads and writes a real system in production, sending the key, and a staging test only reads', async () => {
    wfId = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'integ_flow', definition: withApi() }))).json().workflow.id;
    const versionId = (await get(`/internal/workflows/${wfId}/versions`)).json()[0].id;
    await must(post(`/internal/workflows/${wfId}/deploy`, { versionId, environment: 'staging' }));
    // a simulation never touches the system
    const before = seen.length;
    const sim = (await must(post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 's', variables: { account: 'A-1' },
      integrations: { billing: { data: { paid: false, owing: '1.00' } } }, expect: { outcome: 'promise_recorded', says: ['RM 1.00'] } }] }))).json();
    expect(sim.clean).toBe(true);
    expect(seen.length).toBe(before);
    // a staging test call reads, but its write is refused
    const test = (await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'staging', kind: 'test', variables: { account: 'A-1' } }))).json();
    expect(test).toMatchObject({ status: 'ended', outcome: 'lookup_failed', said: ['You owe RM 350.00.'] });
    expect(seen.slice(before).map((s) => s.method)).toEqual(['GET']);
    // production does both
    await must(post(`/internal/workflows/${wfId}/deploy`, { versionId, environment: 'production' }));
    const mark = seen.length;
    const live = (await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'production', kind: 'live', variables: { account: 'A-1' } }))).json();
    expect(live).toMatchObject({ status: 'ended', outcome: 'promise_recorded', said: ['You owe RM 350.00.'] });
    const calls = seen.slice(mark);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/accounts/A-1/status', 'POST /v1/promises']);
    expect(calls.every((c) => c.auth === 'super-secret-key')).toBe(true);
    expect(JSON.parse(calls[1]!.body)).toEqual({ account: 'A-1', amount: '350.00' });
  });

  it('does not let a caller\'s value redirect the request to another path', async () => {
    const mark = seen.length;
    await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'production', kind: 'live', variables: { account: '../../admin?x=1' } }));
    expect(seen[mark]!.url).toBe('/v1/accounts/..%2F..%2Fadmin%3Fx%3D1/status');
  });

  it('records a call that cannot reach the integration as a clean failure', async () => {
    const lonely = (await must(post('/internal/tenants', { name: 'No Integ Co' }))).json().id;
    const w = (await must(post(`/internal/tenants/${lonely}/workflows`, { name: 'integ_flow', definition: withApi() }))).json();
    await must(post(`/internal/workflows/${w.workflow.id}/deploy`, { versionId: w.version.id, environment: 'staging' }));
    const r = (await must(post(`/internal/workflows/${w.workflow.id}/runs`, { environment: 'staging', kind: 'test', variables: { account: 'A' } }))).json();
    expect(r.outcome).toBe('lookup_failed'); // no integration named "billing" for this client: the workflow's own error route
  });
});
