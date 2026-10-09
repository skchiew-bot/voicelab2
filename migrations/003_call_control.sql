-- Phase 1: call control. Our own numbers, the calls themselves, and webhook de-duplication.
-- Customer phone numbers are never stored here: they exist in memory while a call is set up.

-- Numbers WE own at a provider (DIDs). Not personal data; needed to route inbound calls
-- to a client and to check that an outbound caller ID is one of ours.
CREATE TABLE phone_numbers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id),
  e164        text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid REFERENCES projects(id),
  country     char(2) NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, e164)
);

-- One row per call. Status moves forward only; the call-event log is the record of what happened.
CREATE TABLE calls (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  project_id        uuid REFERENCES projects(id),
  provider_id       uuid NOT NULL REFERENCES providers(id),
  provider_call_id  text,
  direction         text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status            text NOT NULL CHECK (status IN
                      ('dialing', 'ringing', 'in_progress', 'completed', 'unanswered', 'failed', 'blocked')),
  country           char(2),
  started_at        timestamptz NOT NULL DEFAULT now(),
  answered_at       timestamptz,
  ended_at          timestamptz,
  duration_seconds  numeric(10,3),
  end_reason        text,
  cost_status       text NOT NULL DEFAULT 'pending' CHECK (cost_status IN ('pending', 'recorded', 'failed')),
  cost_error        text
);
CREATE UNIQUE INDEX calls_provider_call_idx ON calls (provider_id, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX calls_tenant_idx ON calls (tenant_id, started_at);

-- Providers retry webhooks. One row per delivered event makes processing idempotent.
CREATE TABLE webhook_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  uuid NOT NULL REFERENCES providers(id),
  event_key    text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, event_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
