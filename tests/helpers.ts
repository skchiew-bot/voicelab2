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
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const state = {
    calls,
    respond: (_url: string): Response | Promise<Response> =>
      new Response(JSON.stringify({ status: 'active', data: { balance: '12.34', currency: 'USD' } }), { status: 200 }),
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    return state.respond(String(input));
  }) as typeof fetch;
  return { ...state, state, fetch: fetchFn };
}

export async function setupDb() {
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
  };
  const provider = fakeProviderApi();
  const app = buildApp(pool, config, { fetch: provider.fetch });

  const staff = await withActor(pool, { kind: 'internal' }, (c) =>
    createUser(c, null, { tenantId: null, email: 'staff@daythree.test', role: 'internal_admin' }));

  async function teardown() {
    await app.close();
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await a.end();
  }

  /** Call the API as a given token. */
  const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

  return { pool, app, config, provider, staffToken: staff.token, call, teardown };
}
