-- Phase 0: the app runs its own scheduled jobs (owner decision, 2026-10-10: a scheduler on Postgres, no Redis).
-- Each job is one row. A server claims a due job in one short statement that also takes a lease on it, so two servers
-- never run one job at once and a long run is never started again while it is still going; no connection is held while
-- the job runs (lesson L-040). A server that dies mid-run leaves the lease to run out, and the job runs again. Every finished run is recorded, append-only,
-- with counts only (never error text). Internal only: the client role has no grant on either table.

CREATE TABLE scheduled_jobs (
  name                 text PRIMARY KEY,
  every_seconds        int NOT NULL CHECK (every_seconds BETWEEN 60 AND 2678400),
  enabled              boolean NOT NULL DEFAULT true,
  next_run_at          timestamptz NOT NULL DEFAULT now(),
  last_started_at      timestamptz,
  -- Set while a run is under way; a run never takes longer than this, or the job may be started again.
  lease_until          timestamptz,
  last_finished_at     timestamptz,
  last_outcome         text CHECK (last_outcome IN ('ok', 'partly', 'failed')),
  consecutive_failures int NOT NULL DEFAULT 0
);

CREATE TABLE job_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL REFERENCES scheduled_jobs(name),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'partly', 'failed')),
  -- Counts only: how many clients it ran for, how many failed, and the numbers the job itself reported.
  summary      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX job_runs_job_idx ON job_runs (job, id DESC);
CREATE TRIGGER job_runs_immutable BEFORE UPDATE OR DELETE ON job_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE ON scheduled_jobs TO voicelab_internal;
GRANT SELECT, INSERT ON job_runs TO voicelab_internal;
GRANT USAGE ON SEQUENCE job_runs_id_seq TO voicelab_internal;

-- The jobs the app knows, due at once. A job the app adds later is inserted when the scheduler starts.
INSERT INTO scheduled_jobs (name, every_seconds) VALUES
  ('alerts-email', 60), ('cases-dispatch', 60), ('queue-expire', 60), ('faults-sweep', 300),
  ('workflow-runs-sweep', 900), ('appointment-reminders', 900), ('reconcile', 3600), ('learning-sweep', 3600),
  ('payment-checks', 3600), ('case-ageing', 86400);
-- Extra channel charges are not a scheduled job: they bill a past month at today's entitlement, which has no history.
