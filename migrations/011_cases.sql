-- Phase 7, module 1: closed-loop case management. A case follows one person's debt (or request) through callbacks,
-- promises to pay, reminders and treatments until it is settled. The person is known by the client's own reference and
-- by a keyed hash of their number: the number itself is never kept here.

-- How often and when a contact may be called, for the whole platform. No row means no limits.
CREATE TABLE contact_policy (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id),
  time_zone       text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 60),
  quiet_start     text NOT NULL DEFAULT '21:00' CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end       text NOT NULL DEFAULT '08:00' CHECK (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  max_per_day     integer NOT NULL DEFAULT 3 CHECK (max_per_day BETWEEN 1 AND 50),
  max_per_week    integer NOT NULL DEFAULT 10 CHECK (max_per_week BETWEEN 1 AND 200),
  min_gap_minutes integer NOT NULL DEFAULT 60 CHECK (min_gap_minutes BETWEEN 0 AND 10080),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE case_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id),
  payment_integration    text,                                   -- the client's integration that reports what a case has paid
  payment_path           text NOT NULL DEFAULT '/cases/{ref}/payments' CHECK (payment_path LIKE '/%'),
  callback_lateness_min  integer NOT NULL DEFAULT 15 CHECK (callback_lateness_min BETWEEN 1 AND 1440),
  retry_max              integer NOT NULL DEFAULT 3 CHECK (retry_max BETWEEN 0 AND 20),
  retry_backoff_minutes  integer[] NOT NULL DEFAULT '{60,240,1440}',
  rotate_after           integer NOT NULL DEFAULT 2 CHECK (rotate_after BETWEEN 1 AND 20),
  channels               text[] NOT NULL DEFAULT '{voice,whatsapp,sms}',
  treatments             text[] NOT NULL DEFAULT '{friendly,firm,final}',
  ageing_days            integer NOT NULL DEFAULT 30 CHECK (ageing_days BETWEEN 1 AND 3650),
  reminder_lead_hours    integer NOT NULL DEFAULT 24 CHECK (reminder_lead_hours BETWEEN 1 AND 720),
  broken_grace_days      integer NOT NULL DEFAULT 1 CHECK (broken_grace_days BETWEEN 0 AND 60),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(channels) >= 1 AND channels[1] = 'voice'),
  CHECK (cardinality(treatments) >= 1)
);

CREATE TABLE cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  case_ref         text NOT NULL CHECK (length(case_ref) BETWEEN 1 AND 100),
  contact_ref      text CHECK (length(contact_ref) <= 200),
  contact_hash     text NOT NULL,
  time_zone        text NOT NULL,
  country          char(2) NOT NULL,
  currency         char(3) NOT NULL,
  language         text NOT NULL DEFAULT 'en',
  opening_balance  numeric(24,8) NOT NULL CHECK (opening_balance >= 0),
  paid_total       numeric(24,8) NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  treatment        integer NOT NULL DEFAULT 0 CHECK (treatment >= 0),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decision_required', 'closed')),
  close_reason     text,
  needs_human      boolean NOT NULL DEFAULT false,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  UNIQUE (tenant_id, case_ref),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX cases_contact_idx ON cases (tenant_id, contact_hash) WHERE status <> 'closed';

-- What happened to a case, in order. Never edited.
CREATE TABLE case_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id   uuid NOT NULL REFERENCES cases(id),
  kind      text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}',
  actor_id  uuid REFERENCES users(id),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_events_idx ON case_events (case_id, id);
CREATE TRIGGER case_events_immutable BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Work to be done at a time: a callback locked to an hour, a reminder, a thank-you, a retry. Status moves forward.
CREATE TABLE case_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES cases(id),
  kind          text NOT NULL CHECK (kind IN ('callback', 'reminder', 'thanks', 'retry', 'handoff')),
  channel       text NOT NULL DEFAULT 'voice' CHECK (channel IN ('voice', 'whatsapp', 'sms', 'email')),
  scheduled_for timestamptz NOT NULL,                  -- when it is next due; a hold-back moves this
  locked_for    timestamptz NOT NULL,                  -- the time it was locked to; lateness is always measured from this
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'placed', 'done', 'missed', 'unanswered', 'blocked', 'unknown', 'cancelled', 'failed')),
  attempt       integer NOT NULL DEFAULT 1,
  lease_until   timestamptz,
  call_id       uuid,
  dedupe_key    text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_actions_due_idx ON case_actions (scheduled_for) WHERE status = 'pending';
CREATE INDEX case_actions_call_idx ON case_actions (call_id) WHERE call_id IS NOT NULL;
CREATE UNIQUE INDEX case_actions_dedupe_idx ON case_actions (case_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE promises (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id),
  amount      numeric(24,8) NOT NULL CHECK (amount > 0),
  due_on      date NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'partial', 'broken')),
  paid_base   numeric(24,8) NOT NULL DEFAULT 0 CHECK (paid_base >= 0),   -- what the case had paid when the promise was made
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz
);
CREATE INDEX promises_open_idx ON promises (due_on) WHERE status = 'open';

-- Every call attempt and how it went, by the contact's local hour: what reachability is learned from. Never edited.
CREATE TABLE case_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     uuid NOT NULL REFERENCES cases(id),
  action_id   uuid,
  call_id     uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  local_dow   smallint NOT NULL CHECK (local_dow BETWEEN 0 AND 6),
  local_hour  smallint NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  outcome     text NOT NULL CHECK (outcome IN ('answered', 'no_answer', 'busy', 'failed'))
);
CREATE INDEX case_attempts_idx ON case_attempts (case_id, id);
CREATE TRIGGER case_attempts_immutable BEFORE UPDATE OR DELETE ON case_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- An inbound call that matched an open case.
ALTER TABLE calls ADD COLUMN case_id uuid;
CREATE INDEX calls_contact_window_idx ON calls (tenant_id, contact_hash, started_at) WHERE contact_hash IS NOT NULL;
CREATE INDEX calls_case_idx ON calls (case_id) WHERE case_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
