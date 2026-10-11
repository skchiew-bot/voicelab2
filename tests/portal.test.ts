import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
const ids = { a: '', b: '', projA: '', provider: '' };
const tok = { adminA: '', userA: '', adminB: '' };
const users = { adminA: '', userA: '', adminB: '' };
const calls = { a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), b1: randomUUID() };

const must = async (r: Promise<{ statusCode: number; json: () => any }>, status = 201) => { const x = await r; expect(x.statusCode, JSON.stringify(x.json())).toBe(status); return x.json(); };

beforeAll(async () => {
  const { setupDb } = await import('./helpers.js');
  env = await setupDb();
  ids.a = (await must(env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Acme' }))).id;
  ids.b = (await must(env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Bolt' }))).id;
  ids.projA = (await must(env.call(env.staffToken, 'POST', `/internal/tenants/${ids.a}/projects`, { name: 'Collections' }))).id;
  const u = async (t: string, email: string, role: string) => must(env.call(env.staffToken, 'POST', `/internal/tenants/${t}/users`, { email, role }));
  const aa = await u(ids.a, 'admin@acme.test', 'tenant_admin'); tok.adminA = aa.token; users.adminA = aa.id;
  const ua = await u(ids.a, 'user@acme.test', 'tenant_user'); tok.userA = ua.token; users.userA = ua.id;
  const ab = await u(ids.b, 'admin@bolt.test', 'tenant_admin'); tok.adminB = ab.token; users.adminB = ab.id;
  ids.provider = (await must(env.call(env.staffToken, 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC123', authToken: 'FAKE_TOKEN_portal', twimlAppVoiceUrl: 'https://example.com/voice' } }))).id;

  const call = (id: string, tenant: string, project: string | null, minutesAgo: number, status: string, answered: boolean) => env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, answered_at, ended_at, duration_seconds, end_reason, cost_status)
     VALUES ($1,$2,$3,$4,$5,'outbound',$6,'MY', now() - make_interval(mins => $7), CASE WHEN $8 THEN now() - make_interval(mins => $7) END, now() - make_interval(mins => $7 - 1), 60, 'provider-end-reason-secret', 'recorded')`,
    [id, tenant, project, ids.provider, `CA-PROVIDER-${id.slice(0, 6)}`, status, minutesAgo, answered]);
  await call(calls.a1, ids.a, ids.projA, 30, 'completed', true);
  await call(calls.a2, ids.a, ids.projA, 20, 'unanswered', false);
  await call(calls.a3, ids.a, null, 10, 'completed', true);
  await call(calls.b1, ids.b, null, 5, 'completed', true);
  // Provider cost and margin, internal only; an estimated and a reconciled record for the same call.
  for (const [id, t, status] of [[calls.a1, ids.a, 'estimated'], [calls.a1, ids.a, 'reconciled'], [calls.b1, ids.b, 'estimated']] as const) {
    await env.pool.query(`INSERT INTO call_costs (call_id, tenant_id, direction, occurred_at, status, total_usd, myr_per_usd, total_myr, credits_drawn, margin_usd)
      VALUES ($1,$2,'outbound',now(),$3, 0.12345678, 4.5, 0.55555551, 2.5, 0.98765432)`, [id, t, status]);
  }
  // Credits drawn are in the client's own ledger, once per call (reconciling never draws again).
  await env.pool.query(`INSERT INTO credit_entries (tenant_id, project_id, kind, credits, ref) VALUES ($1,$2,'grant','100',NULL), ($1,$2,'usage','-2.5000',$3), ($1,NULL,'usage','-1.2500',$4), ($5,NULL,'usage','-9.0000',$6)`,
    [ids.a, ids.projA, `call:${calls.a1}`, `call:${calls.a3}`, ids.b, `call:${calls.b1}`]);
  await env.pool.query(`INSERT INTO outbound_outcomes (tenant_id, project_id, call_id, outcome) VALUES ($1,$2,$3,'rejected'), ($1,$2,$3,'contacted')`, [ids.a, ids.projA, calls.a1]);
});
afterAll(async () => { await env?.teardown(); });

describe('the client portal: what a client sees', () => {
  it("shows a client its own calls only, with what a client may see and nothing about the provider, cost or margin", async () => {
    const r = await must(env.call(tok.userA, 'GET', '/client/calls'), 200);
    expect(r.calls.map((c: { id: string }) => c.id)).toEqual([calls.a3, calls.a2, calls.a1]);
    expect(Object.keys(r.calls[0]).sort()).toEqual(['answered_at', 'credits_drawn', 'direction', 'duration_seconds', 'ended_at', 'id', 'outcome', 'project', 'project_id', 'started_at', 'status']);
    expect(r.calls.find((c: { id: string }) => c.id === calls.a1)).toMatchObject({ project: 'Collections', status: 'completed', outcome: 'contacted', credits_drawn: '2.5000' });
    expect(r.calls.find((c: { id: string }) => c.id === calls.a2)).toMatchObject({ credits_drawn: '0.0000', outcome: null, answered_at: null });
    const text = JSON.stringify(r);
    for (const secret of ['0.12345678', '0.98765432', '0.55555551', 'CA-PROVIDER', 'provider-end-reason-secret', ids.provider, calls.b1]) expect(text).not.toContain(secret);
    expect((await must(env.call(tok.adminB, 'GET', '/client/calls'), 200)).calls.map((c: { id: string }) => c.id)).toEqual([calls.b1]);
  });

  it('pages through calls, newest first, and filters by project', async () => {
    const p1 = await must(env.call(tok.adminA, 'GET', '/client/calls?limit=2'), 200);
    expect(p1.calls.map((c: { id: string }) => c.id)).toEqual([calls.a3, calls.a2]);
    const p2 = await must(env.call(tok.adminA, 'GET', `/client/calls?limit=2&before=${p1.next}`), 200);
    expect(p2).toEqual({ calls: [expect.objectContaining({ id: calls.a1 })], next: null });
    const byProject = await must(env.call(tok.adminA, 'GET', `/client/calls?projectId=${ids.projA}`), 200);
    expect(byProject.calls.map((c: { id: string }) => c.id)).toEqual([calls.a2, calls.a1]);
    // Another client's call cannot be used as a page marker to learn anything.
    expect((await must(env.call(tok.adminA, 'GET', `/client/calls?before=${calls.b1}`), 200)).calls).toEqual([]);
  });

  it("sums the last 30 days per project from the client's own ledger, counting a reconciled call once", async () => {
    const s = await must(env.call(tok.userA, 'GET', '/client/summary'), 200);
    expect(s).toEqual({ balance: '96.2500', last30Days: [
      { project_id: ids.projA, project: 'Collections', calls: 2, answered: 1, credits_drawn: '2.5000' },
      { project_id: null, project: null, calls: 1, answered: 1, credits_drawn: '1.2500' },
    ] });
  });

  it('says who is signed in, for which client, and in which role', async () => {
    expect(await must(env.call(tok.userA, 'GET', '/client/me'), 200)).toEqual({ email: 'user@acme.test', role: 'tenant_user', client: 'Acme' });
    expect((await env.call(env.staffToken, 'GET', '/client/me')).statusCode).toBe(403);
  });
});

describe('the client portal: managing a client\'s own users', () => {
  it('lets a client admin add a user to their own client, with a token shown once, and audits it without the email', async () => {
    const r = await must(env.call(tok.adminA, 'POST', '/client/users', { email: ' New.Person@Acme.test ', role: 'tenant_user' }));
    expect(r).toMatchObject({ email: 'new.person@acme.test', role: 'tenant_user' });
    expect((await must(env.call(r.token, 'GET', '/client/me'), 200)).client).toBe('Acme');
    const row = (await env.pool.query('SELECT tenant_id, created_by FROM users WHERE id = $1', [r.id])).rows[0];
    expect(row).toEqual({ tenant_id: ids.a, created_by: users.adminA });
    const audit = (await env.pool.query("SELECT actor_id, detail FROM audit_log WHERE action = 'user.create' AND entity_id = $1", [r.id])).rows;
    expect(audit).toEqual([{ actor_id: users.adminA, detail: { role: 'tenant_user', by: 'client' } }]);
    const list = await must(env.call(tok.adminA, 'GET', '/client/users'), 200);
    expect(list.map((u: { email: string }) => u.email)).toEqual(['admin@acme.test', 'new.person@acme.test', 'user@acme.test']);
    expect(JSON.stringify(list)).not.toMatch(/token|bolt/);
  });

  it('refuses everything else: a client user managing users, a staff role, a duplicate email, and another client\'s user', async () => {
    expect((await env.call(tok.userA, 'GET', '/client/users')).statusCode).toBe(403);
    expect((await env.call(tok.userA, 'POST', '/client/users', { email: 'x@acme.test', role: 'tenant_user' })).statusCode).toBe(403);
    expect((await env.call(tok.adminA, 'POST', '/client/users', { email: 'x@acme.test', role: 'internal_admin' })).statusCode).toBe(400);
    expect((await env.call(tok.adminA, 'POST', '/client/users', { email: 'ADMIN@acme.test', role: 'tenant_user' })).statusCode).toBe(409); // already one of this client's users
    expect((await env.call(tok.adminA, 'POST', `/client/users/${users.adminB}/disable`)).statusCode).toBe(404);
    expect((await env.call(tok.adminA, 'POST', `/client/users/${users.adminA}/disable`)).statusCode).toBe(409);
    expect((await env.pool.query('SELECT disabled_at FROM users WHERE id = $1', [users.adminB])).rows[0].disabled_at).toBeNull();
  });

  it('disables a user of the client at once and for good', async () => {
    const r = await must(env.call(tok.adminA, 'POST', '/client/users', { email: 'leaver@acme.test', role: 'tenant_user' }));
    expect((await env.call(r.token, 'GET', '/client/calls')).statusCode).toBe(200);
    expect((await must(env.call(tok.adminA, 'POST', `/client/users/${r.id}/disable`), 200)).disabled_at).toBeTruthy();
    expect((await env.call(r.token, 'GET', '/client/calls')).statusCode).toBe(401);
    expect((await env.call(tok.adminA, 'POST', `/client/users/${r.id}/disable`)).statusCode).toBe(409);
  });

  it('keeps one of two client admins who disable each other at the same moment', async () => {
    const x = await must(env.call(tok.adminB, 'POST', '/client/users', { email: 'x@bolt.test', role: 'tenant_admin' }));
    const [p, q] = await Promise.all([
      env.call(tok.adminB, 'POST', `/client/users/${x.id}/disable`),
      env.call(x.token, 'POST', `/client/users/${users.adminB}/disable`),
    ]);
    expect([p.statusCode, q.statusCode].filter((n) => n === 200)).toHaveLength(1);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' AND disabled_at IS NULL", [ids.b])).rows[0].n).toBe(1);
  });
});

describe('the client portal in the database', () => {
  const asClient = <T>(tenantId: string, fn: (c: import('pg').PoolClient) => Promise<T>) => withActor(env.pool, { kind: 'client', tenantId }, fn);

  it('still gives the client role no grant on calls, call costs, providers or users: only the two views', async () => {
    for (const t of ['calls', 'call_costs', 'call_cost_lines', 'providers', 'users', 'outbound_outcomes']) {
      await expect(asClient(ids.a, (c) => c.query(`SELECT * FROM ${t}`)), t).rejects.toThrow(/permission denied/);
    }
    const rows = await asClient(ids.a, async (c) => (await c.query('SELECT id FROM client_calls')).rows.map((r) => r.id).sort());
    expect(rows).toEqual([calls.a1, calls.a2, calls.a3].sort());
    expect(await asClient(ids.b, async (c) => (await c.query('SELECT count(*)::int AS n FROM client_users')).rows[0].n)).toBe(2);
  });

  it('shows nothing when no client is set, and refuses user changes from anyone but an active admin of that client', async () => {
    // A connection as the client role with no client set sees no calls and can change no one.
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE voicelab_client');
      expect((await c.query('SELECT count(*)::int AS n FROM client_calls')).rows[0].n).toBe(0);
      await expect(c.query("SELECT * FROM client_add_user($1, 'z@acme.test', 'tenant_user', 'h')", [users.adminA])).rejects.toThrow(/no client/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    // Called directly with an actor who is not an admin of this client.
    await expect(asClient(ids.a, (c) => c.query("SELECT * FROM client_add_user($1, 'z@acme.test', 'tenant_user', 'h')", [users.userA]))).rejects.toThrow(/only an active client admin/);
    await expect(asClient(ids.a, (c) => c.query("SELECT * FROM client_add_user($1, 'z@acme.test', 'tenant_user', 'h')", [users.adminB]))).rejects.toThrow(/only an active client admin/);
    await expect(asClient(ids.a, (c) => c.query("SELECT * FROM client_add_user($1, 'z@acme.test', 'internal_admin', 'h')", [users.adminA]))).rejects.toThrow(/not a client role/);
    await expect(asClient(ids.b, (c) => c.query('SELECT * FROM client_disable_user($1, $2)', [users.adminB, users.userA]))).rejects.toThrow(/no such user/);
  });

  it('holds when two admins of a client disable each other in overlapping transactions: the second waits, then finds it was switched off', async () => {
    const mk = async (email: string) => (await env.pool.query("INSERT INTO users (tenant_id, email, role, token_hash) VALUES ($1, $2, 'tenant_admin', $3) RETURNING id", [ids.a, email, randomUUID()])).rows[0].id as string;
    const [p, q] = [await mk('p@acme.test'), await mk('q@acme.test')];
    const open = async () => { const c = await env.pool.connect(); await c.query('BEGIN'); await c.query('SET LOCAL ROLE voicelab_client'); await c.query("SELECT set_config('app.tenant_id', $1, true)", [ids.a]); return c; };
    const c1 = await open(); const c2 = await open();
    try {
      await c1.query('SELECT * FROM client_disable_user($1, $2)', [p, q]); // p switches q off, not yet committed
      const second = c2.query('SELECT * FROM client_disable_user($1, $2)', [q, p]).then(() => 'done', (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 200));
      await c1.query('COMMIT');
      expect(await second).toMatch(/only an active client admin/);
      await c2.query('ROLLBACK');
    } finally { c1.release(); c2.release(); }
    expect((await env.pool.query('SELECT id FROM users WHERE id = ANY($1) AND disabled_at IS NULL', [[p, q]])).rows.map((r) => r.id)).toEqual([p]);
  });

  it('tells a client admin nothing about emails outside their own client: another client\'s user or a member of staff is a new user here', async () => {
    for (const email of ['admin@bolt.test', 'staff@daythree.test']) {
      const r = await env.call(tok.adminA, 'POST', '/client/users', { email, role: 'tenant_user' });
      expect({ email, status: r.statusCode }).toEqual({ email, status: 201 });
    }
    // Two people, one email, apart: the staff member is untouched and still signs in to the console as staff.
    expect((await env.call(env.staffToken, 'GET', '/me')).json()).toMatchObject({ email: 'staff@daythree.test', role: 'internal_admin' });
    expect((await env.pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'staff@daythree.test'")).rows[0].n).toBe(2);
    // The installer finds the staff member, never the client's user of the same email.
    const { bootstrapAdmin } = await import('../src/store/tenants.js');
    expect(await withActor(env.pool, { kind: 'internal' }, (c) => bootstrapAdmin(c, 'staff@daythree.test'))).toMatchObject({ created: false, role: 'internal_admin' });
  });

  it('refuses a disabled admin called directly, even with the right client set', async () => {
    const r = await must(env.call(tok.adminA, 'POST', '/client/users', { email: 'gone-admin@acme.test', role: 'tenant_admin' }));
    await must(env.call(tok.adminA, 'POST', `/client/users/${r.id}/disable`), 200);
    await expect(asClient(ids.a, (c) => c.query("SELECT * FROM client_add_user($1, 'z2@acme.test', 'tenant_user', 'h')", [r.id]))).rejects.toThrow(/only an active client admin/);
    await expect(asClient(ids.a, (c) => c.query('SELECT * FROM client_disable_user($1, $2)', [r.id, users.userA]))).rejects.toThrow(/only an active client admin/);
  });

  it('holds when staff disable a client admin while that admin disables another: the client is not left with no admin by the race', async () => {
    const { disableUser } = await import('../src/store/tenants.js');
    const mk = async (email: string) => (await env.pool.query("INSERT INTO users (tenant_id, email, role, token_hash) VALUES ($1, $2, 'tenant_admin', $3) RETURNING id", [ids.b, email, randomUUID()])).rows[0].id as string;
    // Bolt is down to exactly these two admins.
    await env.pool.query("UPDATE users SET disabled_at = now(), disabled_by = id WHERE tenant_id = $1 AND role = 'tenant_admin' AND disabled_at IS NULL", [ids.b]);
    const [m, n] = [await mk('m@bolt.test'), await mk('n@bolt.test')];
    const staffId = (await env.pool.query("SELECT id FROM users WHERE email = 'staff@daythree.test' AND tenant_id IS NULL")).rows[0].id as string;
    const c1 = await env.pool.connect(); const c2 = await env.pool.connect();
    try {
      await c1.query('BEGIN'); await c1.query('SET LOCAL ROLE voicelab_internal');
      await disableUser(c1, staffId, m); // staff switch m off, not yet committed
      await c2.query('BEGIN'); await c2.query('SET LOCAL ROLE voicelab_client'); await c2.query("SELECT set_config('app.tenant_id', $1, true)", [ids.b]);
      const second = c2.query('SELECT * FROM client_disable_user($1, $2)', [m, n]).then(() => 'done', (e: Error) => e.message); // meanwhile m switches n off
      await new Promise((r) => setTimeout(r, 200));
      await c1.query('COMMIT');
      expect(await second).toMatch(/only an active client admin/);
      await c2.query('ROLLBACK');
    } finally { c1.release(); c2.release(); }
    expect((await env.pool.query('SELECT id FROM users WHERE id = ANY($1) AND disabled_at IS NULL', [[m, n]])).rows.map((r) => r.id)).toEqual([n]);
  });

  it('lets the client role reach exactly what the portal needs, and nothing a later migration quietly adds', async () => {
    const tables = (await env.pool.query(
      `SELECT c.relname, array_agg(p.priv ORDER BY p.priv) AS privs FROM pg_class c
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(priv)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'p', 'm') AND has_table_privilege('voicelab_client', c.oid, p.priv)
        GROUP BY c.relname ORDER BY c.relname`)).rows;
    expect(tables).toEqual([
      { relname: 'client_calls', privs: ['SELECT'] }, { relname: 'client_tenant', privs: ['SELECT'] }, { relname: 'client_users', privs: ['SELECT'] },
      { relname: 'credit_entries', privs: ['SELECT'] }, { relname: 'projects', privs: ['SELECT'] },
    ]);
    // Functions that run with their owner's rights are the ones that matter; only the portal's two exist.
    const definers = (await env.pool.query(
      `SELECT p.proname, has_function_privilege('voicelab_client', p.oid, 'EXECUTE') AS client, has_function_privilege('public', p.oid, 'EXECUTE') AS anyone
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef ORDER BY p.proname`)).rows;
    expect(definers).toEqual([{ proname: 'client_add_user', client: true, anyone: false }, { proname: 'client_disable_user', client: true, anyone: false }]);
  });
});
