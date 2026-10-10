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
});
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
const fill = (p: string) => p.replace(/:tenantId/g, tenantId).replace(/:[A-Za-z]+/g, () => randomUUID());
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
    const gets = routes().filter((r) => r.method === 'GET' && r.path.startsWith('/internal/'));
    expect(gets.length).toBeGreaterThan(50);
    for (const r of gets) {
      const url = fill(r.path);
      const [a, v] = [await inject(env.staffToken, 'GET', url), await inject(viewer, 'GET', url)];
      expect({ route: r.path, status: v.statusCode }).toEqual({ route: r.path, status: a.statusCode });
      expect(v.statusCode).toBeLessThan(500);
    }
  });

  it('is refused every change, on every route, and nothing in the database moves', async () => {
    const changes = routes().filter((r) => r.method !== 'GET' && r.path.startsWith('/internal/'));
    expect(changes.length).toBeGreaterThan(50);
    const before = await rowCounts();
    for (const r of changes) {
      const res = await inject(viewer, r.method, fill(r.path), {});
      expect({ route: r.path, refused: res.statusCode === 403 || res.statusCode === 400 }).toEqual({ route: r.path, refused: true });
    }
    // The tenant routes take a real client, so the refusal there must be the role, not a bad request.
    expect((await inject(viewer, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'x' })).statusCode).toBe(403);
    expect((await inject(viewer, 'POST', '/internal/tenants', { name: 'x' })).statusCode).toBe(403);
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
    await expect(env.pool.query('UPDATE users SET disabled_at = NULL, disabled_by = NULL WHERE id = $1', [u.json().id])).rejects.toThrow(/only be disabled, once/);
    await expect(env.pool.query('DELETE FROM users WHERE id = $1', [u.json().id])).rejects.toThrow(/never deleted/);
    await expect(env.pool.query("UPDATE users SET role = 'internal_admin', tenant_id = NULL WHERE email = 'viewer@daythree.test'")).rejects.toThrow(/only be disabled, once/);
    expect((await env.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.disable' AND entity_id = $1", [u.json().id])).rows[0].n).toBe(1);
  });

  it('leaves user management to admins: a viewer cannot add or disable anyone', async () => {
    expect((await inject(viewer, 'POST', '/internal/staff', { email: 'z@daythree.test', role: 'internal_admin' })).statusCode).toBe(403);
    const me = (await env.call(env.staffToken, 'GET', '/internal/users')).json().find((u: { email: string }) => u.email === 'staff@daythree.test');
    expect((await inject(viewer, 'POST', `/internal/users/${me.id}/disable`)).statusCode).toBe(403);
  });

  it('never leaves the platform without an active admin, even when two admins disable each other at once', async () => {
    const mk = async (email: string) => { const r = await env.call(env.staffToken, 'POST', '/internal/staff', { email, role: 'internal_admin' }); expect(r.statusCode).toBe(201); return r.json(); };
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
