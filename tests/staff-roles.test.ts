import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string;
let viewer: string;

beforeAll(async () => {
  const { setupDb } = await import('./helpers.js');
  env = await setupDb();
  const t = await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Acme' });
  expect(t.statusCode).toBe(201);
  tenantId = t.json().id;
  const v = await env.call(env.staffToken, 'POST', '/internal/staff', { email: 'viewer@daythree.test', role: 'internal_viewer' });
  expect(v.statusCode).toBe(201);
  viewer = v.json().token;
  // Real records, so the read-only comparison runs the screens' real code, not just their "not found" paths.
  const must = async (r: Promise<{ statusCode: number; json: () => any }>) => { const x = await r; expect(x.statusCode, JSON.stringify(x.json())).toBe(201); return x.json(); };
  const KL = 'Asia/Kuala_Lumpur';
  ids.id = (await must(env.call(env.staffToken, 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC123', authToken: 'FAKE_TOKEN_x', twimlAppVoiceUrl: 'https://example.com/voice' } }))).id;
  await must(env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/workflows/from-template`, { template: 'debt_collection_my' }));
  ids.diaryId = (await must(env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/diaries`, { name: 'Desk', kind: 'individual', officerRef: 'officer-1', timeZone: KL }))).id;
  ids.caseId = (await must(env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/cases`, { caseRef: 'C-1', phone: '+60123450001', country: 'MY', currency: 'MYR', openingBalance: '100', timeZone: KL }))).id;
  ids.articleId = (await must(env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/knowledge`, { slug: 'fees', title: 'Fees', body: 'A late fee applies after seven days.', tags: [] }))).id;
  ids.workflowId = (await env.pool.query('SELECT id FROM workflows ORDER BY created_at LIMIT 1')).rows[0].id;
  ids.caseId ??= (await env.pool.query('SELECT id FROM cases LIMIT 1')).rows[0].id;
  ids.articleId ??= (await env.pool.query('SELECT id FROM knowledge_articles LIMIT 1')).rows[0].id;
  for (const [k, val] of Object.entries(ids)) expect(val, k).toMatch(/^[0-9a-f-]{36}$/);
});
const ids: Record<string, string> = {};
afterAll(async () => { await env?.teardown(); });

/** Every route the API declares, read from the source so a new route is covered without editing this test. */
function routes() {
  const files = ['src/app.ts', ...readdirSync('src/routes').map((f) => `src/routes/${f}`)];
  const out: { method: string; path: string }[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) out.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  }
  return out;
}
const fill = (p: string) => p.replace(/:tenantId/g, tenantId).replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? randomUUID());
const inject = (token: string, method: string, url: string, payload?: unknown) =>
  env.app.inject({ method: method as 'GET', url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

async function rowCounts() {
  const { rows } = await env.pool.query("SELECT relname FROM pg_class WHERE relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace ORDER BY relname");
  const out: Record<string, number> = {};
  for (const r of rows) out[r.relname] = (await env.pool.query(`SELECT count(*)::int AS n FROM "${r.relname}"`)).rows[0].n;
  return out;
}

describe('read-only staff', () => {
  it('can read every internal screen the way an admin can, in a read-only transaction that never fails', async () => {
    const gets = routes().filter((r) => r.method === 'GET' && r.path.startsWith('/internal/') && r.path !== '/internal/users');
    expect(gets.length).toBeGreaterThan(50);
    let found = 0;
    for (const r of gets) {
      const url = fill(r.path);
      const [a, v] = [await inject(env.staffToken, 'GET', url), await inject(viewer, 'GET', url)];
      expect({ route: r.path, status: v.statusCode }).toEqual({ route: r.path, status: a.statusCode });
      expect(v.statusCode).toBeLessThan(500);
      if (v.statusCode === 200) found++;
    }
    expect(found).toBeGreaterThan(60); // most screens answered with real data, not "not found"
    // The list of every user's email is for admins only.
    expect((await inject(viewer, 'GET', '/internal/users')).statusCode).toBe(403);
  });

  it('is refused every change, on every route, and nothing in the database moves', async () => {
    const changes = routes().filter((r) => r.method !== 'GET' && r.path.startsWith('/internal/'));
    expect(changes.length).toBeGreaterThan(50);
    const before = await rowCounts();
    for (const r of changes) {
      const res = await inject(viewer, r.method, fill(r.path), {});
      expect({ route: r.path, status: res.statusCode }).toEqual({ route: r.path, status: 403 });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('is refused by the database too if a change ever reaches it', async () => {
    const { withActor } = await import('../src/db.js');
    await expect(withActor(env.pool, { kind: 'internal', readOnly: true }, (c) => c.query("INSERT INTO tenants (name) VALUES ('sneaky')")))
      .rejects.toThrow(/read-only transaction/);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM tenants WHERE name = 'sneaky'")).rows[0].n).toBe(0);
  });

  it('says who they are, so the console can show it is read-only', async () => {
    expect((await inject(viewer, 'GET', '/me')).json()).toEqual({ email: 'viewer@daythree.test', role: 'internal_viewer', readOnly: true });
    expect((await inject(env.staffToken, 'GET', '/me')).json()).toEqual({ email: 'staff@daythree.test', role: 'internal_admin', readOnly: false });
  });
});

describe('managing who can sign in', () => {
  it('adds staff with a token shown once, lists users without any token, and audits it', async () => {
    const res = await env.call(env.staffToken, 'POST', '/internal/staff', { email: 'second@daythree.test', role: 'internal_admin' });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/.{20,}/);
    const list = await env.call(env.staffToken, 'GET', '/internal/users');
    expect(list.statusCode).toBe(200);
    const users = list.json() as { email: string; role: string; disabled_at: string | null }[];
    expect(users.find((u) => u.email === 'second@daythree.test')).toMatchObject({ role: 'internal_admin', disabled_at: null });
    expect(JSON.stringify(users)).not.toMatch(/token/);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.create' AND detail->>'email' = 'second@daythree.test'")).rows[0].n).toBe(1);
  });

  it('refuses a staff role for a client user and a client role for staff', async () => {
    expect((await env.call(env.staffToken, 'POST', '/internal/staff', { email: 'x@daythree.test', role: 'tenant_admin' })).statusCode).toBe(400);
    expect((await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/users`, { email: 'x@acme.test', role: 'internal_viewer' })).statusCode).toBe(400);
    await expect(env.pool.query("INSERT INTO users (tenant_id, email, role, token_hash) VALUES ($1, 'y@acme.test', 'internal_viewer', 'h1')", [tenantId])).rejects.toThrow(/users_staff_have_no_tenant/);
  });

  it('switches a user off at once, for good, and records who did it', async () => {
    const u = await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/users`, { email: 'leaver@acme.test', role: 'tenant_user' });
    expect(u.statusCode).toBe(201);
    expect((await inject(u.json().token, 'GET', '/client/credits')).statusCode).toBe(200);
    const off = await env.call(env.staffToken, 'POST', `/internal/users/${u.json().id}/disable`);
    expect(off.statusCode).toBe(200);
    expect(off.json().disabled_at).toBeTruthy();
    expect((await inject(u.json().token, 'GET', '/client/credits')).statusCode).toBe(401);
    expect((await env.call(env.staffToken, 'POST', `/internal/users/${u.json().id}/disable`)).statusCode).toBe(409);
    await expect(env.pool.query('UPDATE users SET disabled_at = NULL, disabled_by = NULL WHERE id = $1', [u.json().id])).rejects.toThrow(/only be approved once and disabled once/);
    await expect(env.pool.query('DELETE FROM users WHERE id = $1', [u.json().id])).rejects.toThrow(/never deleted/);
    await expect(env.pool.query("UPDATE users SET role = 'internal_admin', tenant_id = NULL WHERE email = 'viewer@daythree.test'")).rejects.toThrow(/only be approved once and disabled once/);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.disable' AND entity_id = $1", [u.json().id])).rows[0].n).toBe(1);
  });

  it('leaves user management to admins: a viewer cannot add or disable anyone', async () => {
    expect((await inject(viewer, 'POST', '/internal/staff', { email: 'z@daythree.test', role: 'internal_admin' })).statusCode).toBe(403);
    const me = (await env.call(env.staffToken, 'GET', '/internal/users')).json().find((u: { email: string }) => u.email === 'staff@daythree.test');
    expect((await inject(viewer, 'POST', `/internal/users/${me.id}/disable`)).statusCode).toBe(403);
  });

  it('never leaves the platform without an active admin, even when two admins disable each other at once', async () => {
    const mk = activeAdmin;
    // Start from exactly two active admins: disable everyone else first.
    const a = await mk('a@daythree.test'); const b = await mk('b@daythree.test');
    for (const u of (await env.call(env.staffToken, 'GET', '/internal/users')).json() as { id: string; role: string; disabled_at: string | null; email: string }[]) {
      if (u.role === 'internal_admin' && !u.disabled_at && u.id !== a.id && u.id !== b.id && u.email !== 'staff@daythree.test') {
        expect((await env.call(a.token, 'POST', `/internal/users/${u.id}/disable`)).statusCode).toBe(200);
      }
    }
    const staff = (await env.call(a.token, 'GET', '/internal/users')).json().find((u: { email: string }) => u.email === 'staff@daythree.test');
    expect((await env.call(a.token, 'POST', `/internal/users/${staff.id}/disable`)).statusCode).toBe(200);
    expect((await env.call(a.token, 'POST', `/internal/users/${a.id}/disable`)).statusCode).toBe(409); // not yourself

    const [x, y] = await Promise.all([
      env.call(a.token, 'POST', `/internal/users/${b.id}/disable`),
      env.call(b.token, 'POST', `/internal/users/${a.id}/disable`),
    ]);
    // One wins; the other finds it has been disabled, either inside the lock (403) or at sign-in (401).
    expect([x.statusCode, y.statusCode].filter((n) => n === 200)).toHaveLength(1);
    expect([x.statusCode, y.statusCode].every((n) => n === 200 || n === 401 || n === 403)).toBe(true);
    const { rows } = await env.pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'internal_admin' AND disabled_at IS NULL");
    expect(rows[0].n).toBe(1);
  });

  it('holds when the two disables overlap exactly: the second waits, then finds its admin was switched off', async () => {
    const { disableUser } = await import('../src/store/tenants.js');
    const { AppError } = await import('../src/errors.js');
    const mk = async (email: string) => (await env.pool.query("INSERT INTO users (email, role, token_hash) VALUES ($1, 'internal_admin', $2) RETURNING id", [email, randomUUID()])).rows[0].id as string;
    const [p, q] = [await mk('p@daythree.test'), await mk('q@daythree.test')];
    const c1 = await env.pool.connect(); const c2 = await env.pool.connect();
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      await disableUser(c1, p, q); // p switches q off, not yet committed
      const second = disableUser(c2, q, p).then(() => 'done', (e) => e); // meanwhile q tries to switch p off
      await new Promise((r) => setTimeout(r, 200));
      await c1.query('COMMIT');
      const outcome = await second;
      await c2.query('ROLLBACK');
      expect(outcome).toBeInstanceOf(AppError);
      expect((outcome as InstanceType<typeof AppError>).status).toBe(403);
    } finally { c1.release(); c2.release(); }
    const { rows } = await env.pool.query('SELECT id FROM users WHERE id = ANY($1) AND disabled_at IS NULL', [[p, q]]);
    expect(rows.map((r) => r.id)).toEqual([p]);
  });

  it('lets only an admin disable a user, even when the store is called directly', async () => {
    const { disableUser } = await import('../src/store/tenants.js');
    const { withActor } = await import('../src/db.js');
    const ids = Object.fromEntries((await env.pool.query("SELECT email, id FROM users WHERE email IN ('viewer@daythree.test', 'a@daythree.test')")).rows.map((r) => [r.email, r.id]));
    await expect(withActor(env.pool, { kind: 'internal' }, (c) => disableUser(c, ids['viewer@daythree.test'], ids['a@daythree.test']))).rejects.toThrow(/Only an active admin/);
  });
});

describe('a second person for every new admin', () => {
  let boss: { id: string; token: string };
  beforeAll(async () => { boss = await activeAdmin('boss@daythree.test'); });

  it('keeps an admin added by another admin out until a different admin approves them, so one admin cannot invent a second approver', async () => {
    const made = await env.call(boss.token, 'POST', '/internal/staff', { email: 'Twin@DayThree.test', role: 'internal_admin' });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ email: 'twin@daythree.test', pendingApproval: true });
    const twin = made.json();
    // The new identity can do nothing at all, so it can approve nothing its creator proposed.
    const blocked = await inject(twin.token, 'GET', '/internal/tenants');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toMatch(/waiting for another admin/);
    expect((await inject(twin.token, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'p' })).statusCode).toBe(401);
    // Its creator cannot approve it, and nor can a read-only user.
    expect((await env.call(boss.token, 'POST', `/internal/users/${twin.id}/approve`)).statusCode).toBe(403);
    expect((await inject(viewer, 'POST', `/internal/users/${twin.id}/approve`)).statusCode).toBe(403);
    // A different admin can.
    const other = await activeAdmin('other@daythree.test');
    const ok = await env.call(other.token, 'POST', `/internal/users/${twin.id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect((await inject(twin.token, 'GET', '/internal/tenants')).statusCode).toBe(200);
    expect((await env.call(other.token, 'POST', `/internal/users/${twin.id}/approve`)).statusCode).toBe(409);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.approve' AND entity_id = $1", [twin.id])).rows[0].n).toBe(1);
    // The database holds the rule too.
    const pend = await env.call(boss.token, 'POST', '/internal/staff', { email: 'self@daythree.test', role: 'internal_admin' });
    expect(pend.statusCode).toBe(201);
    await expect(env.pool.query('UPDATE users SET approved_at = now(), approved_by = created_by WHERE id = $1', [pend.json().id])).rejects.toThrow(/users_approved_by_another/);
  });

  it('treats an email in another case as the same person', async () => {
    expect((await env.call(boss.token, 'POST', '/internal/staff', { email: 'VIEWER@daythree.test', role: 'internal_viewer' })).statusCode).toBe(409);
  });

  it('needs no approval for read-only staff or client users, who can approve nothing', async () => {
    const v = await env.call(boss.token, 'POST', '/internal/staff', { email: 'look2@daythree.test', role: 'internal_viewer' });
    expect(v.statusCode).toBe(201);
    expect(v.json().pendingApproval).toBe(false);
    expect((await inject(v.json().token, 'GET', '/internal/tenants')).statusCode).toBe(200);
  });
});

/** An admin made the way the installer makes one (no creator), so it is active without approval. */
async function activeAdmin(email: string) {
  const { bootstrapAdmin } = await import('../src/store/tenants.js');
  const { withActor } = await import('../src/db.js');
  const r = await withActor(env.pool, { kind: 'internal' }, (c) => bootstrapAdmin(c, email));
  if (!r.created) throw new Error('admin already exists');
  return r as { id: string; token: string };
}

describe('the installer', () => {
  it('creates the first admin once, and running it again to upgrade changes nothing', async () => {
    const { bootstrapAdmin } = await import('../src/store/tenants.js');
    const { withActor } = await import('../src/db.js');
    const first = await withActor(env.pool, { kind: 'internal' }, (c) => bootstrapAdmin(c, 'owner@daythree.test'));
    expect(first).toMatchObject({ created: true, email: 'owner@daythree.test', role: 'internal_admin' });
    const again = await withActor(env.pool, { kind: 'internal' }, (c) => bootstrapAdmin(c, 'owner@daythree.test'));
    expect(again).toEqual({ created: false, email: 'owner@daythree.test', role: 'internal_admin', disabled: false });
    expect((await env.pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'owner@daythree.test'")).rows[0].n).toBe(1);
  });
});
