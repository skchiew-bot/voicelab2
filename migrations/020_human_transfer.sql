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
  CHECK (transfer_status IN ('unavailable', 'dialing', 'answered', 'unanswered', 'failed', 'abandoned', 'unknown'));
ALTER TABLE calls ADD COLUMN transfer_started_at timestamptz;
-- When the agent pressed 1 to take the call. With screening on, a dial counts as answered only if this is set, so an
-- agent's voicemail picking up is never taken for a person.
ALTER TABLE calls ADD COLUMN transfer_accepted_at timestamptz;
-- Whether this call's dial screened the agent (the client's setting when the dial began, so a change mid-dial does not
-- change how its end is read).
ALTER TABLE calls ADD COLUMN transfer_screened boolean;
-- The agent's leg is a call of its own at the provider: its id (never a number) and length, so it is costed with the
-- caller's call and checked against the provider's figures.
ALTER TABLE calls ADD COLUMN transfer_leg_sid text;
ALTER TABLE calls ADD COLUMN transfer_seconds numeric(10,3) CHECK (transfer_seconds >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_settings TO voicelab_internal;
