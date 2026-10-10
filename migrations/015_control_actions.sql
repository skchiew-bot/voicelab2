-- Actions an operator takes from the Control Tower. Who did each and why is in the audit log; these hold the current
-- state the call path reads.

-- A drained provider gets no new calls (calls under way finish); it stays drained until someone restores it. A
-- preferred telephony provider is chosen first when the caller-ID pool picks a number.
CREATE TABLE provider_controls (
  provider_id     uuid PRIMARY KEY REFERENCES providers(id),
  drained_at      timestamptz,
  drained_by      uuid REFERENCES users(id),
  drained_reason  text,
  preferred       boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((drained_at IS NULL) = (drained_reason IS NULL))
);

-- How many outbound dials may start in any one minute, across the platform. No row, or null, means no limit.
CREATE TABLE dial_pace (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  per_minute  integer CHECK (per_minute IS NULL OR per_minute BETWEEN 1 AND 100000),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The dialling pace counts outbound dials started in the last minute on every dial.
CREATE INDEX calls_outbound_started_idx ON calls (started_at) WHERE direction = 'outbound';

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
