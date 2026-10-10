import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPool, withActor } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createUser } from '../src/store/tenants.js';

// Server connection used to create a throwaway database per test file.
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://voicelab:voicelab@localhost:5432/postgres';

/**
 * Stands in for the providers' APIs: no test touches the real ones. By default every
 * check succeeds; a test sets `respond` to simulate a rejection or an outage.
 */
export function fakeProviderApi() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const state = {
    calls,
    respond: (_url: string, _init?: RequestInit): Response | Promise<Response> =>
      new Response(JSON.stringify({ status: 'active', data: { balance: '12.34', currency: 'USD' } }), { status: 200 }),
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    });
    return state.respond(String(input), init);
  }) as typeof fetch;
  return { ...state, state, fetch: fetchFn };
}

export async function setupDb(opts: { integrationHttp?: import('../src/workflows/integrations.js').HttpDeps; judges?: import('../src/store/qa.js').QaDeps['judges']; learning?: import('../src/app.js').Deps['learning']; cases?: import('../src/app.js').Deps['cases']; mailer?: import('../src/app.js').Deps['mailer'] } = {}) {
  const name = `voicelab_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await migrate(pool);

  const config: Config = {
    DATABASE_URL: url.toString(),
    VOICELAB_SECRET_KEY: randomBytes(32).toString('base64'),
    PORT: 0,
    PUBLIC_BASE_URL: 'https://voicelab.test',
    RECONCILE_TOLERANCE_PCT: 2,
    SCHEDULER: 'off', // tests drive the scheduler with tick()
  };
  const provider = fakeProviderApi();
  const app = buildApp(pool, config, { fetch: provider.fetch, integrationHttp: opts.integrationHttp, judges: opts.judges, learning: opts.learning, cases: opts.cases, mailer: opts.mailer });

  const staff = await withActor(pool, { kind: 'internal' }, (c) =>
    createUser(c, null, { tenantId: null, email: 'staff@daythree.test', role: 'internal_admin' }));

  async function teardown() {
    await app.close();
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await dropDatabase(a, name);
    await a.end();
  }

  /** Call the API as a given token. */
  const call = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

  return { pool, app, config, provider, staffToken: staff.token, call, teardown };
}

/**
 * Drop a test database. FORCE ends its other sessions, but the test role may not end one the server itself runs there
 * (an autovacuum worker): "permission denied to terminate process". Such a worker finishes in moments, so try again;
 * any other error is real and thrown at once.
 */
export async function dropDatabase(a: { query(sql: string): Promise<unknown> }, name: string, waitMs = 250, attempts = 40) {
  for (let attempt = 1; ; attempt++) {
    try { await a.query(`DROP DATABASE ${name} WITH (FORCE)`); return attempt; }
    catch (err) {
      if (attempt >= attempts || !/permission denied to terminate process/.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
