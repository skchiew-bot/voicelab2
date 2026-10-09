-- Phase 3: pre-recorded audio, the DID pool with its permanent failure lock, and outbound outcomes.

-- Voice Lab-owned pre-recorded audio. A recording is for exact words in one language: it is found by a hash of those
-- words, so a workflow's text and the audio played for it can never drift apart. A new take is a new version.
CREATE TABLE recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  language      text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  text_hash     text NOT NULL,
  version       integer NOT NULL,
  label         text,
  content_type  text NOT NULL CHECK (content_type IN ('audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/basic')),
  audio         bytea NOT NULL CHECK (octet_length(audio) BETWEEN 1 AND 5242880),
  sha256        text NOT NULL,
  duration_ms   integer NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 600000),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, language, text_hash, version)
);
CREATE INDEX recordings_lookup_idx ON recordings (tenant_id, language, text_hash, version DESC);

-- The DID pool. Our own numbers carry a state and a use count, so rotation is a plain database rule.
ALTER TABLE phone_numbers
  ADD COLUMN status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN use_count    integer NOT NULL DEFAULT 0;

-- What a call was dialled from, and a keyed hash of who it was dialled to. The customer's number itself is not kept.
ALTER TABLE calls
  ADD COLUMN from_number_id uuid REFERENCES phone_numbers(id),
  ADD COLUMN contact_hash   text;

-- A DID that failed for a contact is locked away from that contact for good. One row per failure; rows are never
-- changed or deleted, so the lock cannot be undone by accident.
CREATE TABLE did_failures (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  phone_number_id  uuid NOT NULL REFERENCES phone_numbers(id),
  contact_hash     text NOT NULL,
  reason           text NOT NULL CHECK (reason IN ('spam_flagged', 'carrier_blocked', 'rejected_on_sight', 'caller_id_invalid')),
  call_id          uuid,
  recorded_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX did_failures_contact_idx ON did_failures (tenant_id, contact_hash, phone_number_id);
CREATE TRIGGER did_failures_immutable BEFORE UPDATE OR DELETE ON did_failures
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- How an answered or unanswered outbound call turned out. Append-only: the latest row for a call is the current one.
CREATE TABLE outbound_outcomes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  project_id     uuid REFERENCES projects(id),
  call_id        uuid NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('contacted', 'rejected', 'wrong_number', 'third_party')),
  callback_day   smallint CHECK (callback_day BETWEEN 0 AND 6),
  callback_hour  smallint CHECK (callback_hour BETWEEN 0 AND 23),
  callback_tz    text,
  recorded_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((callback_day IS NULL) = (callback_hour IS NULL) AND (callback_hour IS NULL) = (callback_tz IS NULL))
);
CREATE INDEX outbound_outcomes_call_idx ON outbound_outcomes (call_id, id DESC);
CREATE TRIGGER recordings_immutable BEFORE UPDATE OR DELETE ON recordings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER outbound_outcomes_immutable BEFORE UPDATE OR DELETE ON outbound_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Internal staff only. Clients get nothing here: audio, the pool and its failure history are not theirs to read.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
