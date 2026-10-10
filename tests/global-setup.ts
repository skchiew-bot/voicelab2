// Runs once, before any test file (registered in vitest.config.ts).
//
// Each test file migrates a database of its own, and the files run in parallel. The first
// migration also creates the cluster-wide roles (`voicelab_internal`, `voicelab_client`) after
// checking they are not there, so on a brand-new Postgres cluster, as in a fresh cloud container,
// files that migrate at the same moment both pass the check and all but one fail with a duplicate
// role (lesson L-001). Migrating one scratch database here first creates everything cluster-wide
// before the files start. A server it cannot reach is reported, not thrown: the tests that need no
// database still run.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { ADMIN_URL, dropDatabase } from './helpers.js';

export type ClusterState =
  | { state: 'prepared'; migrations: string[]; scratch: string }
  | { state: 'unreachable'; reason: string }
  | { state: 'failed'; reason: string };

declare module 'vitest' {
  export interface ProvidedContext { testCluster: ClusterState }
}

/** Who the tests connect as, without the password. */
const who = (url: string) => { const u = new URL(url); return `${decodeURIComponent(u.username)} at ${u.host}`; };

/** Migrate one scratch database, then drop it, so every cluster-wide object exists before the test files start. */
export async function prepareCluster(adminUrl = ADMIN_URL): Promise<ClusterState> {
  const admin = new pg.Client({ connectionString: adminUrl });
  try { await admin.connect(); } catch (err) {
    await admin.end().catch(() => {});
    return { state: 'unreachable', reason: `cannot connect as ${who(adminUrl)}: ${(err as Error).message}` };
  }
  const name = `voicelab_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const pool = createPool(url.toString());
    try { return { state: 'prepared', migrations: await migrate(pool), scratch: name }; } finally { await pool.end(); }
  } catch (err) {
    return { state: 'failed', reason: (err as Error).message };
  } finally {
    if (created) await dropDatabase(admin, name).catch(() => {});
    await admin.end();
  }
}

export default async function setup(project: TestProject) {
  const cluster = await prepareCluster();
  project.provide('testCluster', cluster);
  if (cluster.state !== 'prepared') {
    console.warn(`Test database ${cluster.state}: ${cluster.reason}. The database tests will fail. `
      + 'In a cloud session, `CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh` starts Postgres and creates the test role.');
  }
}
