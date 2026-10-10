-- Phase 5: reconstructing a call, tickets for escalations, QA scoring, the AI decision audit and approved changes.

-- A call can carry a workflow run, so the run's steps can be laid beside the call's own events.
ALTER TABLE workflow_runs ADD COLUMN call_id uuid;
CREATE INDEX workflow_runs_call_idx ON workflow_runs (call_id) WHERE call_id IS NOT NULL;

-- When each step happened (the row's own time is the transaction's, the same for every step of one request).
ALTER TABLE workflow_run_steps ADD COLUMN occurred_at timestamptz;

-- How a call ended, and whether the system dropped it. A fault is flagged where it happened.
ALTER TABLE calls
  ADD COLUMN ended_by      text CHECK (ended_by IN ('customer', 'system')),
  ADD COLUMN ended_node    text,
  ADD COLUMN fault         boolean NOT NULL DEFAULT false,
  ADD COLUMN fault_reason  text,
  ADD COLUMN fault_at      timestamptz;
CREATE INDEX calls_fault_idx ON calls (fault_at) WHERE fault;

-- One row of settings: how long a system drop may go unflagged.
CREATE TABLE journey_settings (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  drop_alert_latency_s integer NOT NULL DEFAULT 60 CHECK (drop_alert_latency_s BETWEEN 1 AND 3600),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO journey_settings DEFAULT VALUES;

-- Someone has seen the fault. One acknowledgement per call, never edited.
CREATE TABLE fault_acks (
  call_id      uuid PRIMARY KEY REFERENCES calls(id),
  acked_by     uuid REFERENCES users(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fault_acks_immutable BEFORE UPDATE OR DELETE ON fault_acks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- How a client's calls are read: when to escalate, and words that add to the built-in ones.
CREATE TABLE journey_config (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
  max_recoveries  integer NOT NULL DEFAULT 2 CHECK (max_recoveries BETWEEN 1 AND 10),
  negative_below  numeric(4,2) NOT NULL DEFAULT -0.30 CHECK (negative_below BETWEEN -1 AND 0),
  severe_below    numeric(4,2) NOT NULL DEFAULT -0.75 CHECK (severe_below BETWEEN -1 AND 0),
  lexicon         jsonb NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- A ticket for a human escalation (or a system fault). Every field a reviewer needs is required, and a ticket is never
-- edited: what happens to it afterwards is recorded in ticket_events.
CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  call_id         uuid,
  run_id          uuid,
  kind            text NOT NULL CHECK (kind IN ('escalation', 'fault')),
  trigger         text NOT NULL CHECK (length(trigger) > 0),
  reason          text NOT NULL CHECK (length(reason) > 0),
  node            text,
  customer_view   text NOT NULL CHECK (length(customer_view) > 0),
  ai_reviews      jsonb NOT NULL CHECK (jsonb_typeof(ai_reviews) = 'array' AND jsonb_array_length(ai_reviews) >= 1),
  council_notes   jsonb NOT NULL CHECK (jsonb_typeof(council_notes) = 'object'),
  impact          jsonb NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (call_id IS NOT NULL OR run_id IS NOT NULL)
);
-- One ticket of each kind for a thing that went wrong, however many times it is reported.
CREATE UNIQUE INDEX tickets_run_idx ON tickets (run_id, kind) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX tickets_call_idx ON tickets (call_id, kind) WHERE run_id IS NULL;
CREATE INDEX tickets_tenant_idx ON tickets (tenant_id, created_at DESC);
CREATE TRIGGER tickets_immutable BEFORE UPDATE OR DELETE ON tickets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ticket_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES tickets(id),
  kind        text NOT NULL CHECK (kind IN ('status', 'note', 'council')),
  status      text CHECK (status IN ('open', 'in_review', 'resolved')),
  note        text,
  actor_id    uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'status' OR status IS NOT NULL)
);
CREATE INDEX ticket_events_idx ON ticket_events (ticket_id, id);
CREATE TRIGGER ticket_events_immutable BEFORE UPDATE OR DELETE ON ticket_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- QA criteria per client and use case. A change is a new version; scores point at the version they used.
CREATE TABLE qa_criteria_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  use_case    text NOT NULL CHECK (length(use_case) BETWEEN 1 AND 100),
  version     integer NOT NULL,
  criteria    jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_array_length(criteria) BETWEEN 1 AND 50),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, use_case, version)
);
CREATE TRIGGER qa_criteria_immutable BEFORE UPDATE OR DELETE ON qa_criteria_sets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE qa_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  run_id           uuid NOT NULL,
  call_id          uuid,
  criteria_set_id  uuid NOT NULL REFERENCES qa_criteria_sets(id),
  score            numeric(6,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  results          jsonb NOT NULL,
  scorer           text NOT NULL,
  model            text,
  tier             text,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  escalated_from   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, criteria_set_id)
);
CREATE INDEX qa_scores_tenant_idx ON qa_scores (tenant_id, created_at DESC);
CREATE TRIGGER qa_scores_immutable BEFORE UPDATE OR DELETE ON qa_scores FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every decision an AI made that mattered, and why it went ahead, was turned down, or was sent back for rework.
CREATE TABLE ai_decisions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id),
  task           text NOT NULL,
  subject_type   text NOT NULL,
  subject_id     text NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('proceeded', 'rejected', 'reworked')),
  reason         text NOT NULL CHECK (length(reason) > 0),
  model          text,
  tier           text CHECK (tier IN ('rules', 'haiku', 'sonnet', 'opus')),
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  confidence     numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  escalated_from text,
  call_id        uuid,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_decisions_subject_idx ON ai_decisions (subject_type, subject_id);
CREATE INDEX ai_decisions_call_idx ON ai_decisions (call_id) WHERE call_id IS NOT NULL;
CREATE TRIGGER ai_decisions_immutable BEFORE UPDATE OR DELETE ON ai_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- How many levels of approval a client's process changes need, in order.
CREATE TABLE approval_policies (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  levels      jsonb NOT NULL CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) BETWEEN 1 AND 5),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A proposed change to a live workflow: from the version live now to a new one, with why and what it would cost.
CREATE TABLE change_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  workflow_id      uuid NOT NULL REFERENCES workflows(id),
  environment      text NOT NULL CHECK (environment IN ('staging', 'production')),
  from_version_id  uuid REFERENCES workflow_versions(id),
  to_version_id    uuid NOT NULL REFERENCES workflow_versions(id),
  reason           text NOT NULL CHECK (length(reason) > 0),
  levels           jsonb NOT NULL,
  financial        jsonb NOT NULL,
  requested_by     uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER change_requests_immutable BEFORE UPDATE OR DELETE ON change_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The history of approval, kept for good. One decision per level.
CREATE TABLE change_approvals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_id   uuid NOT NULL REFERENCES change_requests(id),
  level       integer NOT NULL CHECK (level >= 0),
  decision    text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note        text,
  decided_by  uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_id, level)
);
CREATE TRIGGER change_approvals_immutable BEFORE UPDATE OR DELETE ON change_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Once applied, a change is recorded as applied, once.
CREATE TABLE change_applications (
  change_id    uuid PRIMARY KEY REFERENCES change_requests(id),
  deployment_id bigint,
  applied_by   uuid REFERENCES users(id),
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER change_applications_immutable BEFORE UPDATE OR DELETE ON change_applications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
