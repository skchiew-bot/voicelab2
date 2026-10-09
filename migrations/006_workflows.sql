-- Phase 2: workflows, immutable versions, staging/production deployments, runs and simulations.

CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- A saved version never changes. An edit inside nodes is a minor version (1.0 -> 1.1); a change of shape is major (1.1 -> 2.0).
-- A version with errors can be saved (work in progress) but never deployed.
CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  major       integer NOT NULL CHECK (major >= 1),
  minor       integer NOT NULL CHECK (minor >= 0),
  change      text NOT NULL CHECK (change IN ('initial', 'minor', 'major')),
  definition  jsonb NOT NULL,
  valid       boolean NOT NULL,
  issues      jsonb NOT NULL,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, major, minor)
);

-- Which version is live in an environment is the newest row here. A rollback is a new row, never an edit.
CREATE TABLE workflow_deployments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id  uuid NOT NULL REFERENCES workflows(id),
  environment  text NOT NULL CHECK (environment IN ('staging', 'production')),
  version_id   uuid NOT NULL REFERENCES workflow_versions(id),
  kind         text NOT NULL CHECK (kind IN ('deploy', 'rollback')),
  deployed_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_deployments_idx ON workflow_deployments (workflow_id, environment, id DESC);

-- A list-based simulation: many scripted callers run through one version in staging. Production needs a clean one.
CREATE TABLE simulation_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  version_id  uuid NOT NULL REFERENCES workflow_versions(id),
  total       integer NOT NULL,
  passed      integer NOT NULL,
  failed      integer NOT NULL,
  results     jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulation_batches_idx ON simulation_batches (version_id);

-- One call through a workflow. It pins the version of every workflow it can reach when it starts, so a deploy or a
-- rollback never changes a call that is already under way. state_version stops two replies from clobbering each other.
CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  workflow_id   uuid NOT NULL REFERENCES workflows(id),
  version_id    uuid NOT NULL REFERENCES workflow_versions(id),
  environment   text NOT NULL CHECK (environment IN ('staging', 'production')),
  kind          text NOT NULL CHECK (kind IN ('simulation', 'test', 'live')),
  batch_id      uuid REFERENCES simulation_batches(id),
  pins          jsonb NOT NULL,
  state         jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('running', 'awaiting_reply', 'ended')),
  outcome       text,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE workflow_run_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES workflow_runs(id),
  seq         integer NOT NULL,
  type        text NOT NULL,
  workflow    text NOT NULL,
  node        text,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

-- Systems a workflow can call mid-call. The key (if any) is encrypted and never returned.
CREATE TABLE integrations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  base_url     text NOT NULL,
  auth_header  text,
  auth_secret  bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK ((auth_header IS NULL) = (auth_secret IS NULL))
);

CREATE TRIGGER workflow_versions_immutable   BEFORE UPDATE OR DELETE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER workflow_deployments_immutable BEFORE UPDATE OR DELETE ON workflow_deployments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER simulation_batches_immutable  BEFORE UPDATE OR DELETE ON simulation_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER workflow_run_steps_immutable  BEFORE UPDATE OR DELETE ON workflow_run_steps
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Internal staff only for now. The client role gets nothing: a workflow's logic, variables and integrations are not theirs to read.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
