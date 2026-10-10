import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { prepareCluster } from './global-setup.js';
import { ADMIN_URL } from './helpers.js';

// A fresh cloud container: the tests' database setup and the session-start hook that prepares it.
const root = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'fresh-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('database setup before the test files run (lesson L-001)', () => {
  it('migrates one scratch database before any test file, so files migrating at once never race to create the cluster-wide roles', async () => {
    const cluster = inject('testCluster'); // provided by tests/global-setup.ts, before this file started
    const files = readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(cluster).toMatchObject({ state: 'prepared', migrations: files });
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      const roles = await admin.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('voicelab_internal', 'voicelab_client') ORDER BY 1`);
      expect(roles.rows.map((r) => r.rolname)).toEqual(['voicelab_client', 'voicelab_internal']);
      // And it leaves nothing behind.
      const again = await prepareCluster();
      expect(again).toMatchObject({ state: 'prepared', migrations: files });
      const left = await admin.query('SELECT 1 FROM pg_database WHERE datname = ANY($1)', [[(cluster as { scratch: string }).scratch, (again as { scratch: string }).scratch]]);
      expect(left.rowCount).toBe(0);
    } finally { await admin.end(); }
  });

  it('reports a server it cannot log in to, without the password, instead of stopping the tests that need no database', async () => {
    const url = new URL(ADMIN_URL);
    url.password = 'not-the-password';
    const r = await prepareCluster(url.toString());
    expect(r.state).toBe('unreachable');
    expect((r as { reason: string }).reason).toContain(`${url.username} at ${url.host}`);
    expect(JSON.stringify(r)).not.toContain('not-the-password');
  });
});

describe('cloud session start hook (lesson L-035)', () => {
  const HOOK = path.join(root, '.claude/hooks/session-start.sh');
  // Stand-ins for the system's commands, so the test never starts a server or installs anything.
  // Each records how it was called; the state of the "container" lives in files.
  const container = (opts: { status?: 'online' | 'down'; role?: boolean; installed?: boolean; startFails?: boolean } = {}) => {
    const dir = mkdtempSync(path.join(scratch, 'c-'));
    const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const project = path.join(dir, 'project');
    for (const d of [bin, state, project]) mkdirSync(d);
    writeFileSync(path.join(state, 'status'), opts.status ?? 'down');
    if (opts.role) writeFileSync(path.join(state, 'role'), '');
    if (opts.startFails) writeFileSync(path.join(state, 'start-fails'), '');
    writeFileSync(path.join(project, 'package-lock.json'), '{}');
    if (opts.installed) { mkdirSync(path.join(project, 'node_modules')); writeFileSync(path.join(project, 'node_modules/.package-lock.json'), '{}'); }
    const stub = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/bash\nS='${state}'\n${body}\n`, { mode: 0o755 });
    stub('pg_lsclusters', 'echo "16 main 5432 $(cat "$S/status") postgres /var/lib/postgresql/16/main /var/log/postgresql/16.log"');
    stub('pg_ctlcluster', 'echo "pg_ctlcluster $*" >> "$S/calls"; [ -f "$S/start-fails" ] && exit 1; echo online > "$S/status"');
    stub('runuser', [
      'echo "runuser $*" >> "$S/calls"',
      'case "$*" in *"SELECT 1 FROM pg_roles"*) [ -f "$S/role" ] && echo 1; exit 0 ;; *"CREATE ROLE"*) touch "$S/role"; exit 0 ;; esac',
      'exit 1',
    ].join('\n'));
    stub('npm', 'echo "npm $*" >> "$S/calls"; mkdir -p node_modules; echo {} > node_modules/.package-lock.json');
    const calls = () => (existsSync(path.join(state, 'calls')) ? readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : []);
    const run = (env: Record<string, string | undefined> = { CLAUDE_CODE_REMOTE: 'true' }) => {
      const before = calls().length;
      const r = spawnSync('bash', [HOOK], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_REMOTE: undefined, ...env } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: calls().slice(before) };
    };
    return { run, project, role: () => existsSync(path.join(state, 'role')), status: () => readFileSync(path.join(state, 'status'), 'utf8').trim() };
  };
  const roleCheck = "runuser -u postgres -- psql -tAq -c SELECT 1 FROM pg_roles WHERE rolname = 'voicelab'";

  it('sets up a fresh container: starts Postgres, creates the test role with only the rights the tests need, installs the dependencies, and does nothing when run again', () => {
    const c = container();
    const first = c.run();
    expect(first.status).toBe(0);
    expect(first.calls).toEqual([
      'pg_ctlcluster 16 main start',
      roleCheck,
      "runuser -u postgres -- psql -q -c CREATE ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'",
      'npm ci --no-audit --no-fund',
    ]);
    expect(first.stdout.trim()).toBe('Cloud session setup: started Postgres 16, created the voicelab test role, installed the npm dependencies.');
    expect([c.status(), c.role()]).toEqual(['online', true]);
    const second = c.run();
    expect(second).toEqual({ status: 0, stdout: '', stderr: '', calls: [roleCheck] });
    // After a restart only the server is down; a changed lockfile means installing again.
    const restarted = container({ status: 'down', role: true, installed: true });
    const lock = path.join(restarted.project, 'package-lock.json');
    utimesSync(lock, new Date(), new Date(Date.now() + 60_000));
    expect(restarted.run()).toMatchObject({ status: 0, calls: ['pg_ctlcluster 16 main start', roleCheck, 'npm ci --no-audit --no-fund'], stdout: 'Cloud session setup: started Postgres 16, installed the npm dependencies.\n' });
  });

  it('does nothing outside a cloud session, and reports a step it could not do while still doing the rest', () => {
    const local = container();
    expect(local.run({})).toEqual({ status: 0, stdout: '', stderr: '', calls: [] });
    const broken = container({ startFails: true });
    const r = broken.run();
    expect(r.status).toBe(0); // never blocks the session
    expect(r.calls).toEqual(['pg_ctlcluster 16 main start', 'npm ci --no-audit --no-fund']); // no role check against a server that is down
    expect(r.stdout).toContain('Cloud session setup: installed the npm dependencies.');
    expect(r.stdout).toContain('could not start Postgres (pg_ctlcluster 16 main start)');
  });
});
