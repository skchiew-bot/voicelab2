import { spawn, spawnSync } from 'node:child_process';
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

  it('reports a server it cannot reach, without the password, instead of stopping the tests that need no database', async () => {
    // A closed port refuses on every machine, whatever its Postgres accepts.
    const r = await prepareCluster('postgres://voicelab:not-the-password@127.0.0.1:1/postgres');
    expect(r.state).toBe('unreachable');
    expect((r as { reason: string }).reason).toContain('voicelab at 127.0.0.1:1');
    expect(JSON.stringify(r)).not.toContain('not-the-password');
  });
});

describe('cloud session start hook (lessons L-035 and L-020)', () => {
  const HOOK = path.join(root, '.claude/hooks/session-start.sh');
  const servers: (() => void)[] = [];
  afterAll(() => { for (const stop of servers) stop(); });
  type Opts = { clusters?: string[]; role?: boolean; login?: boolean; installed?: boolean; startFails?: boolean; notRoot?: boolean; slowInstall?: boolean };
  // Stand-ins for the system's commands, so the test never starts a server or installs anything.
  // Each records how it was called; the state of the "container" lives in files.
  const container = (opts: Opts = {}) => {
    const dir = mkdtempSync(path.join(scratch, 'c-'));
    const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const project = path.join(dir, 'project');
    for (const d of [bin, state, project]) mkdirSync(d);
    writeFileSync(path.join(state, 'clusters'), (opts.clusters ?? ['16 main 5432 down']).map((c) => `${c} postgres /var/lib/postgresql/x /var/log/postgresql/x.log\n`).join(''));
    for (const [flag, on] of [['role', opts.role], ['login', opts.login], ['start-fails', opts.startFails], ['not-root', opts.notRoot]] as const) if (on) writeFileSync(path.join(state, flag), '');
    writeFileSync(path.join(project, 'package-lock.json'), '{}');
    if (opts.installed) { mkdirSync(path.join(project, 'node_modules')); writeFileSync(path.join(project, 'node_modules/.package-lock.json'), '{}'); }
    const stub = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/bash\nS='${state}'\n${body}\n`, { mode: 0o755 });
    stub('pg_lsclusters', 'cat "$S/clusters"');
    // Like the real one, it leaves the server running in the background, holding whatever it was given.
    stub('pg_ctlcluster', 'echo "pg_ctlcluster $*" >> "$S/calls"; [ -f "$S/start-fails" ] && exit 1; sed -i "s/ $2 5432 down / $2 5432 online /" "$S/clusters"; (sleep 30 >/dev/null 2>&1 & echo $! > "$S/server.pid")');
    stub('psql', 'echo "psql $*" >> "$S/calls"; [ -f "$S/login" ]'); // a login as voicelab works only once set up
    stub('runuser', [
      'echo "runuser $*" >> "$S/calls"',
      '[ -f "$S/not-root" ] && { echo "runuser: may not be used by non-root users" >&2; exit 1; }',
      'case "$*" in *"SELECT 1 FROM pg_roles"*) [ -f "$S/role" ] && echo 1; exit 0 ;; *"CREATE ROLE"*|*"ALTER ROLE"*) touch "$S/role" "$S/login"; exit 0 ;; esac',
      'exit 1',
    ].join('\n'));
    stub('npm', `echo "npm $*" >> "$S/calls"; ${opts.slowInstall ? 'sleep 1; ' : ''}mkdir -p node_modules; echo {} > node_modules/.package-lock.json`);
    const calls = () => (existsSync(path.join(state, 'calls')) ? readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n') : []);
    const env = (extra: Record<string, string | undefined>) => ({
      ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, CLAUDE_PROJECT_DIR: project, SESSION_SETUP_LOCK_WAIT: '2',
      CLAUDE_CODE_REMOTE: undefined, TEST_ADMIN_DATABASE_URL: undefined, ...extra,
    });
    const run = (extra: Record<string, string | undefined> = { CLAUDE_CODE_REMOTE: 'true' }) => {
      const before = calls().length;
      const r = spawnSync('bash', [HOOK], { encoding: 'utf8', env: env(extra) });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: calls().slice(before) };
    };
    const runAsync = () => new Promise<string>((resolve) => {
      const p = spawn('bash', [HOOK], { env: env({ CLAUDE_CODE_REMOTE: 'true' }) });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out));
    });
    const stop = () => { try { process.kill(Number(readFileSync(path.join(state, 'server.pid'), 'utf8'))); } catch { /* none started */ } };
    servers.push(stop);
    return { run, runAsync, calls, project, log: path.join(dir, 'voicelab-session-setup.log'), has: (f: string) => existsSync(path.join(state, f)) };
  };
  const login = 'psql -X -h localhost -U voicelab -d postgres -tAqc SELECT 1';
  const roleCheck = "runuser -u postgres -- psql -XtAq -c SELECT 1 FROM pg_roles WHERE rolname = 'voicelab'";
  const install = 'npm ci --no-audit --no-fund';

  it('is registered to run when a session starts or resumes, not on every compaction or clear', () => {
    const settings = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    const entries = settings.hooks.SessionStart.filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes('.claude/hooks/session-start.sh')));
    expect(entries).toEqual([{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"', timeout: 300 }] }]);
  });

  it('sets up a fresh container: starts Postgres, creates the test role with only the rights the tests need, installs the dependencies, and does nothing when run again', () => {
    const c = container();
    const first = c.run();
    expect(first.status).toBe(0);
    expect(first.calls).toEqual([
      'pg_ctlcluster 16 main start',
      login,
      roleCheck,
      "runuser -u postgres -- psql -Xq -c CREATE ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'",
      install,
    ]);
    expect(first.stdout).toBe('Cloud session setup: started Postgres 16, created the voicelab test role, installed the npm dependencies.\n');
    // The server it started is still running, and does not keep the next run waiting for its lock.
    expect(c.run()).toEqual({ status: 0, stdout: '', stderr: '', calls: [login] });
    // After a restart only the server is down; a changed lockfile means installing again.
    const restarted = container({ role: true, login: true, installed: true });
    utimesSync(path.join(restarted.project, 'package-lock.json'), new Date(), new Date(Date.now() + 60_000));
    expect(restarted.run()).toMatchObject({ status: 0, calls: ['pg_ctlcluster 16 main start', login, install], stdout: 'Cloud session setup: started Postgres 16, installed the npm dependencies.\n' });
  });

  it('repairs a test role the tests cannot log in as, and leaves the login alone when the tests are pointed elsewhere', () => {
    const c = container({ clusters: ['16 main 5432 online'], role: true, installed: true });
    expect(c.run()).toMatchObject({
      calls: [login, roleCheck, "runuser -u postgres -- psql -Xq -c ALTER ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'"],
      stdout: "Cloud session setup: repaired the voicelab test role's login.\n",
    });
    const elsewhere = container({ clusters: ['16 main 5432 online'], installed: true });
    expect(elsewhere.run({ CLAUDE_CODE_REMOTE: 'true', TEST_ADMIN_DATABASE_URL: 'postgres://someone@db.test/postgres' })).toEqual({ status: 0, stdout: '', stderr: '', calls: [] });
  });

  it('reads a server in recovery as online, and uses the online one when two clusters claim the port', () => {
    const recovering = container({ clusters: ['16 main 5432 online,recovery'], role: true, login: true, installed: true });
    expect(recovering.run().calls).toEqual([login]);
    const two = container({ clusters: ['15 old 5432 down', '16 main 5432 online'], role: true, login: true, installed: true });
    expect(two.run()).toEqual({ status: 0, stdout: '', stderr: '', calls: [login] });
  });

  it('runs one setup at a time: a second run waits for the first, then finds nothing left to do', async () => {
    const c = container({ clusters: ['16 main 5432 online'], role: true, login: true, slowInstall: true });
    const [a, b] = await Promise.all([c.runAsync(), c.runAsync()]);
    expect(c.calls().filter((x) => x === install)).toHaveLength(1);
    expect([a, b].sort()).toEqual(['', 'Cloud session setup: installed the npm dependencies.\n']);
  });

  it('does nothing outside a cloud session, and reports a step it could not do, with where to read why, while still doing the rest', () => {
    expect(container().run({})).toEqual({ status: 0, stdout: '', stderr: '', calls: [] });
    const cannotStart = container({ startFails: true });
    const r = cannotStart.run();
    expect(r.status).toBe(0); // never blocks the session
    expect(r.calls).toEqual(['pg_ctlcluster 16 main start', install]); // no login against a server that is down
    expect(r.stdout).toContain('Cloud session setup: installed the npm dependencies.');
    expect(r.stdout).toContain(`could not start Postgres (pg_ctlcluster 16 main start), so database tests or the typecheck may fail. The details are in ${cannotStart.log}.`);
    expect(container({ clusters: ['16 main 5433 online'], installed: true }).run()).toMatchObject({ status: 0, calls: [], stdout: expect.stringContaining('could not find a Postgres cluster on port 5432') });
    const notRoot = container({ clusters: ['16 main 5432 online'], installed: true, notRoot: true });
    expect(notRoot.run()).toMatchObject({ status: 0, calls: [login, roleCheck], stdout: expect.stringContaining('could not check the voicelab test role (as the postgres user)') });
    expect(readFileSync(notRoot.log, 'utf8')).toContain('may not be used by non-root users');
  });
});
