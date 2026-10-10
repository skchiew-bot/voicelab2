-- Passing a live caller to a person. When a workflow hands a call over (its own handoff, or an escalation), the call
-- is put through to the client's agent phone. The agent's number is stored (it is the client's staff, not a customer);
-- the caller's number never is, and the agent sees one of our own numbers, never the caller's.

CREATE TABLE transfer_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id),
  agent_e164    text NOT NULL CHECK (agent_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  ring_seconds  integer NOT NULL DEFAULT 25 CHECK (ring_seconds BETWEEN 5 AND 60),
  whisper       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Where a call's transfer to a person stands. It moves forward only: from nothing to dialling (or to unavailable, when
-- there is no one to put it through to), then from dialling to how it ended. A retried delivery never moves it back.
ALTER TABLE calls ADD COLUMN transfer_status text
  CHECK (transfer_status IN ('unavailable', 'dialing', 'answered', 'unanswered', 'failed', 'abandoned'));
ALTER TABLE calls ADD COLUMN transfer_started_at timestamptz;

GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_settings TO voicelab_internal;
