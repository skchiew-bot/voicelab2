-- Phase 4: provider health and failover, the fallback ladder, concurrency ceilings and entitlements.

-- Tunable thresholds for deciding a provider is failing, and for trusting it again. One row.
CREATE TABLE resilience_policy (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  error_threshold      integer NOT NULL DEFAULT 3 CHECK (error_threshold >= 1),
  error_window_s       integer NOT NULL DEFAULT 60 CHECK (error_window_s >= 1),
  latency_threshold_ms integer NOT NULL DEFAULT 2000 CHECK (latency_threshold_ms >= 1),
  latency_window_s     integer NOT NULL DEFAULT 60 CHECK (latency_window_s >= 1),
  latency_min_samples  integer NOT NULL DEFAULT 5 CHECK (latency_min_samples >= 1),
  dead_air_ms          integer NOT NULL DEFAULT 4000 CHECK (dead_air_ms >= 1),
  recovery_ok_samples  integer NOT NULL DEFAULT 5 CHECK (recovery_ok_samples >= 1),
  recovery_dwell_s     integer NOT NULL DEFAULT 120 CHECK (recovery_dwell_s >= 0),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO resilience_policy DEFAULT VALUES;

-- What each provider did, one row per attempt. Failover decisions are made from the recent window of these.
CREATE TABLE provider_samples (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  uuid NOT NULL REFERENCES providers(id),
  kind         text NOT NULL CHECK (kind IN ('ok', 'error', 'dead_air')),
  latency_ms   integer CHECK (latency_ms >= 0),
  call_id      uuid,
  probe        boolean NOT NULL DEFAULT false,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_samples_idx ON provider_samples (provider_id, at DESC);
CREATE TRIGGER provider_samples_immutable BEFORE UPDATE OR DELETE ON provider_samples
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Current health, one row per provider. A provider with no row is healthy.
CREATE TABLE provider_health (
  provider_id  uuid PRIMARY KEY REFERENCES providers(id),
  state        text NOT NULL CHECK (state IN ('healthy', 'failed', 'unfunded')),
  reason       text,
  ok_streak    integer NOT NULL DEFAULT 0,
  since        timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Every switch, in either direction, and why. Never edited.
CREATE TABLE failover_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope          text NOT NULL CHECK (scope IN ('provider_health', 'voice', 'telephony', 'fallback')),
  tenant_id      uuid REFERENCES tenants(id),
  call_id        uuid,
  run_id         uuid,
  from_provider  uuid REFERENCES providers(id),
  to_provider    uuid REFERENCES providers(id),
  trigger        text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX failover_events_idx ON failover_events (at DESC);
CREATE TRIGGER failover_events_immutable BEFORE UPDATE OR DELETE ON failover_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Which voice providers a client's calls may use, in order of preference.
CREATE TABLE provider_routes (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  role         text NOT NULL CHECK (role IN ('voice')),
  provider_id  uuid NOT NULL REFERENCES providers(id),
  priority     integer NOT NULL CHECK (priority >= 0),
  PRIMARY KEY (tenant_id, role, provider_id),
  UNIQUE (tenant_id, role, priority)
);

-- What a call does when every provider has failed: the call is never dropped dead.
CREATE TABLE fallback_plans (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id),
  holding_message      text NOT NULL CHECK (length(holding_message) BETWEEN 1 AND 500),
  offer_callback       boolean NOT NULL DEFAULT true,
  human_transfer       boolean NOT NULL DEFAULT false,
  voicemail            boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- A caller asked to be called back (or was offered one after a total failure). The client's own reference stands in
-- for the person: no phone number is kept.
CREATE TABLE callback_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  call_id      uuid NOT NULL,
  contact_ref  text CHECK (length(contact_ref) <= 200),
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER callback_requests_immutable BEFORE UPDATE OR DELETE ON callback_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Alert before a provider's balance reaches zero. Levels are in the provider's funding currency.
CREATE TABLE funding_thresholds (
  provider_id    uuid NOT NULL REFERENCES providers(id),
  currency       char(3) NOT NULL,
  warn_below     numeric(18,6) NOT NULL CHECK (warn_below >= 0),
  critical_below numeric(18,6) NOT NULL CHECK (critical_below >= 0),
  PRIMARY KEY (provider_id, currency),
  CHECK (critical_below <= warn_below)
);

-- A client's entitlement to simultaneous inbound calls, and whether they may overburst at a premium.
CREATE TABLE tenant_entitlements (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id),
  inbound_channels            integer NOT NULL DEFAULT 1 CHECK (inbound_channels >= 0),
  extra_channels              integer NOT NULL DEFAULT 0 CHECK (extra_channels >= 0),
  extra_channel_credits       numeric(18,4) NOT NULL DEFAULT 0 CHECK (extra_channel_credits >= 0),
  -- null: no overburst. Otherwise the client pays this multiple of the credits for a call that needed burst capacity.
  overburst_multiplier        numeric(6,3) CHECK (overburst_multiplier >= 1),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Extra channels are charged to credits once a month. One row per client per month makes a repeat charge a no-op.
CREATE TABLE channel_charges (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  month           text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  extra_channels  integer NOT NULL,
  credits         numeric(18,4) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);
CREATE TRIGGER channel_charges_immutable BEFORE UPDATE OR DELETE ON channel_charges
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A call that needed burst capacity is marked, so its cost carries the premium and nothing else does.
ALTER TABLE calls ADD COLUMN burst boolean NOT NULL DEFAULT false;
-- What the client's credits are multiplied by for this call (an overburst premium the client agreed to), if any.
ALTER TABLE calls ADD COLUMN credit_multiplier numeric(6,3) CHECK (credit_multiplier >= 1);
ALTER TABLE calls ADD COLUMN queued_at timestamptz;
ALTER TABLE calls DROP CONSTRAINT calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN
  ('queued', 'dialing', 'ringing', 'in_progress', 'completed', 'unanswered', 'failed', 'blocked'));

-- Internal staff only.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
