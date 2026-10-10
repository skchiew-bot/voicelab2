import type pg from 'pg';
import { withActor } from './db.js';
import { AppError } from './errors.js';
import { audit } from './store/audit.js';

/**
 * Runs the app's own scheduled jobs (owner decision, 2026-10-10: a scheduler on Postgres, no Redis).
 *
 * Each job is a row in `scheduled_jobs`. A server claims a due job by taking that job's advisory lock on a connection it
 * holds for the whole run, then moving the job's next run on. Two servers never run one job at once, and a run that
 * outlasts its interval is not started again while it is still going. A run that dies part-way (a crash, a restart)
 * leaves a start with no finish, which the Control Tower shows as unknown; the job runs again at its next time.
 *
 * Every finished run is recorded with counts only. An error is reported as a category, never its text (lesson L-017),
 * and one client's failure never stops the job for the others (lesson L-006).
 */
export interface Job {
  name: string;
  /** How often it runs when first added; an admin can change it later. */
  everySeconds: number;
  /** Runs once per client when set, each in isolation. */
  perTenant?: boolean;
  run: (tenantId?: string) => Promise<unknown>;
}

export type Outcome = 'ok' | 'partly' | 'failed';
export interface RunResult { job: string; outcome: Outcome; summary: Record<string, number> }

/** The numbers a job reported, and the length of any list it returned. Nothing else is kept. */
export function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

/**
 * Run a batch job again while it keeps filling its batch, up to a bound, adding up its counts. A batch smaller than the
 * limit means nothing more was due.
 */
export async function drain(batch: () => Promise<unknown>, limit: number, maxBatches: number): Promise<Record<string, number>> {
  const total: Record<string, number> = { batches: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const counts = countsOf(await batch());
    total.batches = i + 1;
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    if (Object.values(counts).reduce((a, b) => a + b, 0) < limit) break;
  }
  return total;
}

const add = (into: Record<string, number>, from: Record<string, number>) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; };

export function createScheduler(pool: pg.Pool, jobs: Job[], opts: { log?: (message: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.error(m));
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<RunResult[]> | null = null;
  // Set on shutdown: no new job or client is started, so a stop waits only for the work already under way.
  let stopping = false;

  async function ensureRows() {
    // A job the app knows but the database does not yet (added after the migration) is due at once, at its own interval.
    for (const j of jobs) await pool.query('INSERT INTO scheduled_jobs (name, every_seconds) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [j.name, j.everySeconds]);
  }

  async function runOne(job: Job): Promise<RunResult | null> {
    const conn = await pool.connect();
    let locked = false;
    try {
      locked = (await conn.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`job:${job.name}`])).rows[0].ok as boolean;
      if (!locked) return null; // another server is running it now
      // Claim it only if it is still due: the clock is the database's, the same one every server reads.
      const claim = await conn.query(
        `WITH t AS (SELECT clock_timestamp() AS now)
         UPDATE scheduled_jobs SET next_run_at = t.now + make_interval(secs => every_seconds), last_started_at = t.now
           FROM t WHERE name = $1 AND enabled AND next_run_at <= t.now RETURNING last_started_at`, [job.name]);
      if (claim.rowCount === 0) return null;
      const startedAt: Date = claim.rows[0].last_started_at;

      const summary: Record<string, number> = {};
      let outcome: Outcome;
      if (job.perTenant) {
        const tenants = (await conn.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id as string);
        let failed = 0; let reached = 0;
        for (const t of tenants) {
          if (stopping) break; // the clients not reached are counted as not run, so the run is not called a success
          reached++;
          try { add(summary, countsOf(await job.run(t))); }
          catch (e) { failed++; log(`Scheduled job ${job.name} failed for one client: ${(e as Error)?.name ?? 'Error'}`); }
        }
        summary.clients = tenants.length; summary.clientsFailed = failed; summary.clientsNotReached = tenants.length - reached;
        outcome = failed === 0 && reached === tenants.length ? 'ok' : failed === tenants.length ? 'failed' : 'partly';
      } else {
        try { add(summary, countsOf(await job.run())); outcome = 'ok'; }
        catch (e) { outcome = 'failed'; log(`Scheduled job ${job.name} failed: ${(e as Error)?.name ?? 'Error'}`); }
      }

      await withActor(pool, { kind: 'internal' }, async (c) => {
        const { rows } = await c.query('SELECT clock_timestamp() AS now');
        await c.query('INSERT INTO job_runs (job, started_at, finished_at, outcome, summary) VALUES ($1,$2,$3,$4,$5)', [job.name, startedAt, rows[0].now, outcome, summary]);
        await c.query(
          `UPDATE scheduled_jobs SET last_finished_at = $2, last_outcome = $3,
                  consecutive_failures = CASE WHEN $3 = 'ok' THEN 0 ELSE consecutive_failures + 1 END
            WHERE name = $1`, [job.name, rows[0].now, outcome]);
      });
      return { job: job.name, outcome, summary };
    } finally {
      // A connection whose lock could not be given back is closed, never returned to the pool still holding it.
      let unlockFailed: Error | undefined;
      if (locked) await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${job.name}`]).catch((e) => { unlockFailed = e instanceof Error ? e : new Error('unlock failed'); });
      conn.release(unlockFailed);
    }
  }

  /** Run every due job once. Ticks never overlap on one server; a job that throws while being recorded is logged and skipped. */
  async function tick(): Promise<RunResult[]> {
    if (ticking) return ticking;
    ticking = (async () => {
      const results: RunResult[] = [];
      try { await ensureRows(); } catch { log('Scheduler could not reach the database.'); return results; }
      for (const j of jobs) {
        if (stopping) break;
        try { const r = await runOne(j); if (r) results.push(r); }
        catch (e) { log(`Scheduled job ${j.name} could not be run or recorded: ${(e as Error)?.name ?? 'Error'}`); }
      }
      return results;
    })();
    try { return await ticking; } finally { ticking = null; }
  }

  return {
    tick,
    start(everyMs = 15_000) { stopping = false; if (!timer) { timer = setInterval(() => { void tick(); }, everyMs); timer.unref(); void tick(); } },
    /** Stops starting work at once, and waits only for the job (or the client) already running. */
    async stop() { stopping = true; if (timer) clearInterval(timer); timer = null; if (ticking) await ticking.catch(() => {}); },
    names: jobs.map((j) => j.name),
  };
}

// ------------------------------------------------------------------------------------------------ views and settings
export async function listJobs(c: pg.PoolClient) {
  return (await c.query(
    `SELECT j.name, j.every_seconds, j.enabled, j.next_run_at, j.last_started_at, j.last_finished_at, j.last_outcome, j.consecutive_failures,
            (j.last_started_at IS NOT NULL AND (j.last_finished_at IS NULL OR j.last_finished_at < j.last_started_at)) AS unfinished,
            coalesce((SELECT json_agg(r ORDER BY r.id DESC) FROM (SELECT id, started_at, finished_at, outcome, summary FROM job_runs WHERE job = j.name ORDER BY id DESC LIMIT 5) r), '[]') AS recent
       FROM scheduled_jobs j ORDER BY j.name`)).rows;
}

/**
 * Problems worth an alert: a job failing again and again, or one that is overdue (no server is running jobs, or every
 * server is stuck). A disabled job is not overdue, but it is named, since nothing does its work.
 */
export async function jobProblems(c: pg.PoolClient, known: readonly string[]) {
  // Only jobs this code runs: a job since renamed or removed keeps its row (its runs refer to it) but is nobody's work.
  return (await c.query(
    `SELECT name, enabled, consecutive_failures, last_outcome,
            (enabled AND next_run_at < now() - greatest(make_interval(secs => every_seconds * 2), interval '10 minutes')) AS overdue
       FROM scheduled_jobs WHERE name = ANY($1) ORDER BY name`, [known])).rows
    .filter((r) => !r.enabled || r.overdue || r.consecutive_failures >= 3) as { name: string; enabled: boolean; consecutive_failures: number; last_outcome: Outcome | null; overdue: boolean }[];
}

/** Turn a job on or off, or change how often it runs. Needs a reason, which the change log shows. */
export async function updateJob(c: pg.PoolClient, actorId: string, name: string, e: { enabled?: boolean; everySeconds?: number; reason: string }) {
  const before = (await c.query('SELECT name, enabled, every_seconds FROM scheduled_jobs WHERE name = $1 FOR UPDATE', [name])).rows[0];
  if (!before) throw new AppError(404, 'No such scheduled job.');
  const { rows } = await c.query(
    `UPDATE scheduled_jobs SET enabled = coalesce($2, enabled), every_seconds = coalesce($3, every_seconds),
            next_run_at = CASE WHEN $3::int IS NULL THEN next_run_at ELSE least(next_run_at, now() + make_interval(secs => $3::int)) END
      WHERE name = $1 RETURNING name, enabled, every_seconds, next_run_at`, [name, e.enabled ?? null, e.everySeconds ?? null]);
  await audit(c, actorId, 'scheduler.update', 'scheduled_job', null, {
    job: name, reason: e.reason,
    from: { enabled: before.enabled, everySeconds: before.every_seconds }, to: { enabled: rows[0].enabled, everySeconds: rows[0].every_seconds },
  });
  return rows[0];
}

/** Make a job due now; the next scheduler tick on any server runs it. */
export async function runJobNow(c: pg.PoolClient, actorId: string, name: string, reason: string) {
  const { rows } = await c.query('UPDATE scheduled_jobs SET next_run_at = now() WHERE name = $1 RETURNING name, enabled, next_run_at', [name]);
  if (!rows[0]) throw new AppError(404, 'No such scheduled job.');
  if (!rows[0].enabled) throw new AppError(409, 'This job is turned off. Turn it on first.');
  await audit(c, actorId, 'scheduler.run_now', 'scheduled_job', null, { job: name, reason });
  return rows[0];
}
