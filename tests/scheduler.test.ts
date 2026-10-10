import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countsOf, createScheduler, drain, type Job } from '../src/scheduler.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenants: string[] = [];

beforeAll(async () => {
  const { setupDb } = await import('./helpers.js');
  env = await setupDb();
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const r = await env.call(env.staffToken, 'POST', '/internal/tenants', { name });
    expect(r.statusCode).toBe(201);
    tenants.push(r.json().id);
  }
  tenants = tenants.sort();
});
afterAll(async () => { await env?.teardown(); });

const q = async (sql: string, args: unknown[] = []) => (await env.pool.query(sql, args)).rows;
const due = (name: string) => q('UPDATE scheduled_jobs SET next_run_at = now() - interval \'1 second\', enabled = true WHERE name = $1', [name]);
const job = async (name: string, every = 60) => { await q('INSERT INTO scheduled_jobs (name, every_seconds) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET every_seconds = $2, next_run_at = now(), enabled = true, consecutive_failures = 0', [name, every]); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {} };

describe('the scheduler', () => {
  it('runs each due job once, records the run with its counts, and moves the next run on', async () => {
    await job('t-once', 600);
    let runs = 0;
    const s = createScheduler(env.pool, [{ name: 't-once', everySeconds: 600, run: async () => { runs++; return { sent: 2, skipped: [1, 2, 3], note: 'never kept' }; } }], quiet);
    const [r] = await s.tick();
    expect(r).toEqual({ job: 't-once', outcome: 'ok', summary: { sent: 2, skipped: 3 } });
    expect(await s.tick()).toEqual([]); // not due again for ten minutes
    expect(runs).toBe(1);
    const [row] = await q("SELECT extract(epoch FROM next_run_at - last_started_at)::float AS gap, last_outcome, consecutive_failures, last_finished_at >= last_started_at AS finished FROM scheduled_jobs WHERE name = 't-once'");
    expect(row).toMatchObject({ last_outcome: 'ok', consecutive_failures: 0, finished: true });
    expect(row.gap).toBe(600);
    const runsRows = await q("SELECT outcome, summary FROM job_runs WHERE job = 't-once'");
    expect(runsRows).toEqual([{ outcome: 'ok', summary: { sent: 2, skipped: 3 } }]);
  });

  it('runs a job once when two servers tick at the same moment, and never starts a run again while it is still going', async () => {
    await job('t-race', 60);
    let started = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: Job = { name: 't-race', everySeconds: 60, run: async () => { started++; await gate; return {}; } };
    const a = createScheduler(env.pool, [slow], quiet); const b = createScheduler(env.pool, [slow], quiet);
    const first = a.tick();
    const second = b.tick();
    await sleep(300);
    // The run outlasts its interval: the job is due again, but the server running it still holds it.
    await due('t-race');
    const third = await createScheduler(env.pool, [slow], quiet).tick();
    expect(third).toEqual([]);
    release();
    const done = [...await first, ...await second];
    expect(done).toHaveLength(1);
    expect(started).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM job_runs WHERE job = 't-race'"))[0].n).toBe(1);
  });

  it('keeps going for every other client when one fails, records only a category, and counts failures in a row', async () => {
    await job('t-tenants', 60);
    const seen: string[] = [];
    const s = createScheduler(env.pool, [{ name: 't-tenants', everySeconds: 60, perTenant: true, run: async (t) => {
      seen.push(t!);
      if (t === tenants[1]) throw new Error('Client system said: call +60123456789 for help');
      return { made: 1 };
    } }], { log: (m) => { expect(m).not.toMatch(/\+?6012|help/); } });
    const [r] = await s.tick();
    expect(seen).toEqual(tenants);
    expect(r).toEqual({ job: 't-tenants', outcome: 'partly', summary: { made: 2, clients: 3, clientsFailed: 1, clientsNotReached: 0 } });
    const all = JSON.stringify(await q("SELECT * FROM job_runs WHERE job = 't-tenants'"));
    expect(all).not.toMatch(/60123456789|help|Client system/);
    expect((await q("SELECT consecutive_failures FROM scheduled_jobs WHERE name = 't-tenants'"))[0].consecutive_failures).toBe(1);
  });

  it('records a job that throws as failed and carries on with the next job in the same tick', async () => {
    await job('t-bad', 60); await job('t-good', 60);
    const s = createScheduler(env.pool, [
      { name: 't-bad', everySeconds: 60, run: async () => { throw new TypeError('boom'); } },
      { name: 't-good', everySeconds: 60, run: async () => ({ done: 1 }) },
    ], quiet);
    expect((await s.tick()).map((r) => [r.job, r.outcome])).toEqual([['t-bad', 'failed'], ['t-good', 'ok']]);
  });

  it('keeps only numbers and list lengths from what a job returns', () => {
    expect(countsOf({ a: 1, b: 'text', c: [1, 2], d: { e: 1 }, f: NaN, 'bad key': 3, g: null })).toEqual({ a: 1, c: 2 });
    expect(countsOf('text')).toEqual({});
    expect(countsOf([1, 2])).toEqual({});
  });

  it('keeps the record of runs append-only', async () => {
    await expect(q("UPDATE job_runs SET outcome = 'ok'")).rejects.toThrow();
    await expect(q('DELETE FROM job_runs')).rejects.toThrow();
  });
});

describe("the app's own jobs", () => {
  it('runs every sweep the deploy plan used to schedule from outside, successfully, on a fresh installation', async () => {
    await q('UPDATE scheduled_jobs SET next_run_at = now() - interval \'1 second\' WHERE name NOT LIKE \'t-%\'');
    const results = await env.app.scheduler.tick();
    const names = results.map((r) => r.job).sort();
    expect(names).toEqual(['alerts-email', 'appointment-reminders', 'case-ageing', 'cases-dispatch', 'faults-sweep',
      'learning-sweep', 'payment-checks', 'queue-expire', 'reconcile', 'workflow-runs-sweep']);
    expect(results.filter((r) => r.outcome !== 'ok')).toEqual([]);
    expect(results.find((r) => r.job === 'case-ageing')!.summary.clients).toBe(3);
  });
});

describe('the scheduler in the Control Tower', () => {
  const alertsOf = async () => ((await env.call(env.staffToken, 'GET', '/internal/control-tower')).json().alerts as { code: string; message: string; severity: string; scope?: string; link?: string }[])
    .filter((a) => a.code.startsWith('job_'));

  it('raises nothing while every job is on time, and names a job that is failing, overdue or turned off', async () => {
    await q("DELETE FROM scheduled_jobs WHERE name LIKE 't-%' AND NOT EXISTS (SELECT 1 FROM job_runs r WHERE r.job = name)");
    await q("UPDATE scheduled_jobs SET consecutive_failures = 0, enabled = true, next_run_at = now() + interval '1 minute'");
    expect(await alertsOf()).toEqual([]);
    await q("UPDATE scheduled_jobs SET consecutive_failures = 3 WHERE name = 'reconcile'");
    await q("UPDATE scheduled_jobs SET next_run_at = now() - interval '1 hour' WHERE name = 'cases-dispatch'");
    await q("UPDATE scheduled_jobs SET enabled = false WHERE name = 'case-ageing'");
    expect((await alertsOf()).map((a) => [a.code, a.severity]).sort()).toEqual([['job_failing', 'high'], ['job_off', 'low'], ['job_overdue', 'high']]);
    await q("UPDATE scheduled_jobs SET consecutive_failures = 0, enabled = true, next_run_at = now() + interval '1 minute'");
  });

  it('does not call a job overdue that is only a little late', async () => {
    await q("UPDATE scheduled_jobs SET next_run_at = now() - interval '5 minutes' WHERE name = 'cases-dispatch'");
    expect(await alertsOf()).toEqual([]);
    await q("UPDATE scheduled_jobs SET next_run_at = now() + interval '1 minute'");
  });

  it('lets an admin turn a job off, change how often it runs or run it now, only with a reason, and shows the reason in the change log', async () => {
    const put = (body: object) => env.call(env.staffToken, 'PUT', '/internal/scheduler/reconcile', body);
    expect((await put({ enabled: false })).statusCode).toBe(400);
    expect((await put({ reason: 'Nothing to change here.' })).statusCode).toBe(400);
    expect((await put({ everySeconds: 30, reason: 'Too often.' })).statusCode).toBe(400);
    expect((await put({ enabled: false, reason: 'Call +60123456789 first.' })).statusCode).toBe(400);
    const off = await put({ enabled: false, reason: 'Provider is reconciling its own records today.' });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ name: 'reconcile', enabled: false });
    expect((await env.call(env.staffToken, 'POST', '/internal/scheduler/reconcile/run', { reason: 'Try it now.' })).statusCode).toBe(409);
    expect((await put({ enabled: true, everySeconds: 1800, reason: 'Back on, twice an hour.' })).statusCode).toBe(200);
    expect((await env.call(env.staffToken, 'POST', '/internal/scheduler/reconcile/run', { reason: 'Check a call now.' })).statusCode).toBe(200);
    expect((await env.app.scheduler.tick()).map((r) => r.job)).toEqual(['reconcile']);
    expect((await env.call(env.staffToken, 'PUT', '/internal/scheduler/nope', { enabled: false, reason: 'No such job.' })).statusCode).toBe(404);

    const log = (await env.call(env.staffToken, 'GET', '/internal/change-log?category=platform')).json();
    expect(log.entries.map((e: { action: string; why: string }) => [e.action, e.why])).toEqual([
      ['scheduler.run_now', 'Check a call now.'],
      ['scheduler.update', 'Back on, twice an hour.'],
      ['scheduler.update', 'Provider is reconciling its own records today.'],
    ]);
    const list = (await env.call(env.staffToken, 'GET', '/internal/scheduler')).json() as { name: string; every_seconds: number; recent: unknown[] }[];
    expect(list.find((j) => j.name === 'reconcile')).toMatchObject({ every_seconds: 1800 });
    expect(list.find((j) => j.name === 'reconcile')!.recent.length).toBeGreaterThan(0);
  });

  it('leaves changes to admins: read-only staff can see the jobs but not change or run them', async () => {
    const v = await env.call(env.staffToken, 'POST', '/internal/staff', { email: 'jobs-viewer@daythree.test', role: 'internal_viewer' });
    expect(v.statusCode).toBe(201);
    const token = v.json().token;
    expect((await env.call(token, 'GET', '/internal/scheduler')).statusCode).toBe(200);
    expect((await env.call(token, 'PUT', '/internal/scheduler/reconcile', { enabled: false, reason: 'Viewer tries.' })).statusCode).toBe(403);
    expect((await env.call(token, 'POST', '/internal/scheduler/reconcile/run', { reason: 'Viewer tries.' })).statusCode).toBe(403);
  });
});

describe('review fixes', () => {
  const alertsOf = async () => ((await env.call(env.staffToken, 'GET', '/internal/control-tower')).json().alerts as { code: string; severity: string; scope?: string; link?: string }[])
    .filter((a) => a.code.startsWith('job_'));

  it('raises each job as its own alert, so a second job going wrong is a new alert and a new email', async () => {
    const { alertKey } = await import('../src/store/alerts.js');
    await q("UPDATE scheduled_jobs SET consecutive_failures = 0, enabled = true, next_run_at = now() + interval '1 minute'");
    await q("UPDATE scheduled_jobs SET next_run_at = now() - interval '1 hour' WHERE name IN ('cases-dispatch', 'alerts-email')");
    const a = await alertsOf();
    expect(a.map((x) => x.scope).sort()).toEqual(['alerts-email', 'cases-dispatch']);
    expect(new Set(a.map((x) => alertKey(x as never))).size).toBe(2);
    await q("UPDATE scheduled_jobs SET next_run_at = now() + interval '1 minute'");
  });

  it('says only some clients failed when that is what happened, and never alerts on a job this code no longer runs', async () => {
    await q("INSERT INTO scheduled_jobs (name, every_seconds, next_run_at, consecutive_failures) VALUES ('retired-job', 60, now() - interval '1 day', 9)");
    await q("UPDATE scheduled_jobs SET consecutive_failures = 3, last_outcome = 'partly' WHERE name = 'payment-checks'");
    expect((await alertsOf()).map((x) => [x.code, x.severity, x.scope])).toEqual([['job_partly', 'medium', 'payment-checks']]);
    await q("UPDATE scheduled_jobs SET consecutive_failures = 0, last_outcome = 'ok' WHERE name = 'payment-checks'");
  });

  it('does not schedule extra channel charges, which would bill a past month at today\'s entitlement', async () => {
    expect(env.app.scheduler.names).not.toContain('channel-charges');
    expect((await q("SELECT count(*)::int AS n FROM scheduled_jobs WHERE name = 'channel-charges'"))[0].n).toBe(0);
  });

  it('on stop, starts no further job or client and waits only for the one running; the clients not reached make the run partly', async () => {
    await job('t-stop-a', 60); await job('t-stop-b', 60);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const seen: string[] = []; let bRan = false;
    const s = createScheduler(env.pool, [
      { name: 't-stop-a', everySeconds: 60, perTenant: true, run: async (t) => { seen.push(t!); if (seen.length === 1) await gate; return {}; } },
      { name: 't-stop-b', everySeconds: 60, run: async () => { bRan = true; return {}; } },
    ], quiet);
    s.start(60_000);
    await sleep(300);
    const stopped = s.stop();
    release();
    await stopped;
    expect(seen).toHaveLength(1);
    expect(bRan).toBe(false);
    expect((await q("SELECT outcome, summary FROM job_runs WHERE job = 't-stop-a'"))).toEqual([{ outcome: 'partly', summary: { clients: 3, clientsFailed: 0, clientsNotReached: 2 } }]);
    // Cut short, not failed: it is due again at once, and not counted as a failure.
    expect((await q("SELECT consecutive_failures, next_run_at <= now() AS due, lease_until FROM scheduled_jobs WHERE name = 't-stop-a'"))[0]).toEqual({ consecutive_failures: 0, due: true, lease_until: null });
  });

  it('works through a backlog in batches while each batch is full, and stops at its bound', async () => {
    let left = 45;
    const batch = async () => { const n = Math.min(20, left); left -= n; return { placed: Array.from({ length: n }) }; };
    expect(await drain(batch, 20, 10)).toEqual({ batches: 3, placed: 45 });
    left = 1000;
    expect(await drain(batch, 20, 10)).toEqual({ batches: 10, placed: 200 });
    expect(await drain(async () => ({}), 20, 10)).toEqual({ batches: 1 });
  });

  it('holds no database connection while a job runs, so a job can use every connection there is', async () => {
    await job('t-onepool', 60);
    const pg = await import('pg');
    const one = new pg.default.Pool({ connectionString: env.config.DATABASE_URL, max: 1 });
    try {
      // With one connection and a lock held on it for the run, this job would wait for ever for a connection.
      const s = createScheduler(one, [{ name: 't-onepool', everySeconds: 60, run: async () => ({ rows: (await one.query('SELECT 1 AS x')).rowCount ?? 0 }) }], quiet);
      const r = await Promise.race([s.tick(), sleep(4000).then(() => 'hung' as const)]);
      expect(r).toEqual([{ job: 't-onepool', outcome: 'ok', summary: { rows: 1 } }]);
    } finally { await one.end(); }
  });

  it('runs a job again once the lease of a server that died mid-run has run out, and not before', async () => {
    await job('t-lease', 60);
    // A server claimed it and died: started, never finished, lease still running.
    await q("UPDATE scheduled_jobs SET last_started_at = now() - interval '2 minutes', lease_until = now() + interval '1 hour', next_run_at = now() - interval '1 minute' WHERE name = 't-lease'");
    const s = createScheduler(env.pool, [{ name: 't-lease', everySeconds: 60, run: async () => ({}) }], quiet);
    expect(await s.tick()).toEqual([]);
    expect((await env.call(env.staffToken, 'GET', '/internal/scheduler')).json().find((j: { name: string }) => j.name === 't-lease')).toMatchObject({ unfinished: true });
    await q("UPDATE scheduled_jobs SET lease_until = now() - interval '1 second' WHERE name = 't-lease'");
    expect((await s.tick()).map((r) => r.outcome)).toEqual(['ok']);
    expect((await q("SELECT lease_until FROM scheduled_jobs WHERE name = 't-lease'"))[0].lease_until).toBeNull();
  });

  it('lets a run that outlived its lease record itself, but never report the newer run as finished or give back its lease', async () => {
    await job('t-stale', 60);
    const gates: (() => void)[] = []; let n = 0;
    const j: Job = { name: 't-stale', everySeconds: 60, run: () => { n++; return new Promise((r) => { gates.push(() => r({ run: n })); }); } };
    const a = createScheduler(env.pool, [j], quiet).tick();
    await sleep(200);
    await q("UPDATE scheduled_jobs SET lease_until = now() - interval '1 second', next_run_at = now() - interval '1 second' WHERE name = 't-stale'");
    const b = createScheduler(env.pool, [j], quiet).tick();
    await sleep(200);
    const [bStart] = await q("SELECT last_started_at::text AS s FROM scheduled_jobs WHERE name = 't-stale'");
    gates[0]!(); await a; // the stale run finishes while the newer one is still going
    const [row] = await q("SELECT last_started_at::text AS s, lease_until IS NOT NULL AS leased FROM scheduled_jobs WHERE name = 't-stale'");
    expect(row).toEqual({ s: bStart.s, leased: true });
    expect((await env.call(env.staffToken, 'GET', '/internal/scheduler')).json().find((x: { name: string }) => x.name === 't-stale')).toMatchObject({ unfinished: true });
    expect((await q("SELECT count(*)::int AS n FROM job_runs WHERE job = 't-stale'"))[0].n).toBe(1);
    gates[1]!(); await b;
    expect((await q("SELECT lease_until FROM scheduled_jobs WHERE name = 't-stale'"))[0].lease_until).toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM job_runs WHERE job = 't-stale'"))[0].n).toBe(2);
  });

  it('gives up waiting for a run past its deadline, records it as failed, and keeps the lease since the work may still be going', async () => {
    await job('t-hang', 60);
    const s = createScheduler(env.pool, [{ name: 't-hang', everySeconds: 60, run: () => new Promise(() => {}) }], { ...quiet, deadlineMs: 150 });
    expect(await s.tick()).toEqual([{ job: 't-hang', outcome: 'failed', summary: { timedOut: 1 } }]);
    expect((await q("SELECT lease_until > now() AS leased FROM scheduled_jobs WHERE name = 't-hang'"))[0].leased).toBe(true);
    await due('t-hang');
    expect(await s.tick()).toEqual([]); // still held: not started a second time alongside the stuck one
    const run = await env.call(env.staffToken, 'POST', '/internal/scheduler/t-hang/run', { reason: 'Try again now.' });
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toMatch(/under way, or was cut off; it can run again from/);
  });

  it('stops within its grace period even when a run is stuck, leaving that run unfinished', async () => {
    await job('t-stuck', 60);
    const s = createScheduler(env.pool, [{ name: 't-stuck', everySeconds: 60, run: () => new Promise(() => {}) }], { ...quiet, stopGraceMs: 200 });
    s.start(60_000);
    await sleep(200);
    const t0 = Date.now(); await s.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await env.call(env.staffToken, 'GET', '/internal/scheduler')).json().find((x: { name: string }) => x.name === 't-stuck')).toMatchObject({ unfinished: true });
  });
});
