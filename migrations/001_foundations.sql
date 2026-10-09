-- Phase 0 foundations: tenants, providers, capabilities, versioned charging,
-- two strictly separate ledgers, call-event log, audit log, model config.

-- Two access roles. The app connects as the owner and does SET LOCAL ROLE per
-- request, so isolation is enforced by Postgres, not by application code.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'voicelab_internal') THEN
    CREATE ROLE voicelab_internal NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'voicelab_client') THEN
    CREATE ROLE voicelab_client NOLOGIN;
  END IF;
END $$;
GRANT voicelab_internal TO CURRENT_USER;
GRANT voicelab_client TO CURRENT_USER;

-- Append-only guard shared by every record that must never be rewritten.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: records are append-only', TG_OP, TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------- tenancy
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A campaign or project. Every cost and event record carries one.
CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- tenant_id NULL means Daythree staff. Tokens are stored as SHA-256 hashes.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id),
  email       text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('internal_admin', 'tenant_admin', 'tenant_user')),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'internal_admin') = (tenant_id IS NULL))
);

-- -------------------------------------------------------------- providers
-- Internal only. Non-secret parameters live in params; secrets are encrypted
-- (AES-256-GCM) in secret_params and never leave the server.
CREATE TABLE providers (
  id             uuid PRIMARY KEY,
  adapter_key    text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('telephony', 'voice')),
  name           text NOT NULL UNIQUE,
  params         jsonb NOT NULL DEFAULT '{}',
  secret_params  bytea NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Puppet-Master classification, per provider.
CREATE TABLE provider_capabilities (
  provider_id  uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability   text NOT NULL,
  support      text NOT NULL CHECK (support IN ('native', 'composable', 'unsupported')),
  notes        text,
  PRIMARY KEY (provider_id, capability)
);

-- ------------------------------------------------- versioned charging data
-- A rate change inserts a new version; old versions are never touched.
CREATE TABLE charging_versions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id               uuid NOT NULL REFERENCES providers(id),
  version                   integer NOT NULL,
  effective_from            timestamptz NOT NULL,
  billing_increment_seconds integer NOT NULL CHECK (billing_increment_seconds > 0),
  minimum_charge_seconds    integer NOT NULL DEFAULT 0 CHECK (minimum_charge_seconds >= 0),
  rounding                  text NOT NULL DEFAULT 'up' CHECK (rounding IN ('up', 'nearest', 'down')),
  concurrency_limit         integer CHECK (concurrency_limit > 0),
  burst_premium_multiplier  numeric(6,3) CHECK (burst_premium_multiplier >= 1),
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, version),
  UNIQUE (provider_id, effective_from)
);

CREATE TABLE charging_components (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charging_version_id  uuid NOT NULL REFERENCES charging_versions(id),
  component            text NOT NULL CHECK (component IN
                         ('telephony_leg', 'stt', 'llm', 'tts', 'platform', 'concurrency', 'other')),
  unit                 text NOT NULL CHECK (unit IN
                         ('per_minute', 'per_second', 'per_character', 'per_token', 'per_credit', 'flat')),
  rate                 numeric(18,8) NOT NULL CHECK (rate >= 0),
  currency             char(3) NOT NULL,
  -- e.g. Telnyx bills the call and the SIP trunk as two lines
  billing_line         text NOT NULL DEFAULT 'main'
);

-- Rates start unconfirmed; confirming against the provider's pricing page is a
-- separate append-only record, so the rate row itself is never edited.
CREATE TABLE charging_confirmations (
  charging_version_id  uuid PRIMARY KEY REFERENCES charging_versions(id),
  confirmed_by         uuid NOT NULL REFERENCES users(id),
  source_url           text NOT NULL,
  confirmed_at         timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- ledger 1 of 2
-- Provider funding: Voice Lab's own balance with providers (cost of goods).
-- Internal only; the client role has no privileges on it.
CREATE TABLE provider_funding_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id  uuid NOT NULL REFERENCES providers(id),
  kind         text NOT NULL CHECK (kind IN ('topup', 'usage', 'adjustment')),
  amount       numeric(18,6) NOT NULL,   -- signed: usage is negative
  currency     char(3) NOT NULL,
  ref          text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- ledger 2 of 2
-- Voice Lab credits: the client balance. Tenants may read their own rows.
CREATE TABLE credit_entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid REFERENCES projects(id),
  kind        text NOT NULL CHECK (kind IN ('grant', 'usage', 'adjustment')),
  credits     numeric(18,4) NOT NULL,    -- signed: usage is negative
  ref         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- event log
-- Everything later (Control Tower, replay, cost) reads from this. Payloads can
-- hold provider cost, so clients get no direct access; client-safe views come
-- with the phases that need them.
CREATE TABLE call_events (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  project_id   uuid REFERENCES projects(id),
  call_id      uuid NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE call_events_default PARTITION OF call_events DEFAULT;

CREATE FUNCTION ensure_call_events_partition(month_start date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part text := 'call_events_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF call_events FOR VALUES FROM (%L) TO (%L)',
      part, month_start, (month_start + interval '1 month')::date);
  END IF;
END $$;

SELECT ensure_call_events_partition(date_trunc('month', now() + (n || ' month')::interval)::date)
FROM generate_series(0, 2) AS n;

CREATE INDEX call_events_call_idx   ON call_events (call_id, occurred_at);
CREATE INDEX call_events_tenant_idx ON call_events (tenant_id, occurred_at);

-- ------------------------------------------------------- audit + config
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Model choice per AI task is configuration, not code (see CLAUDE.md).
CREATE TABLE model_config (
  task_key       text PRIMARY KEY,
  tier           text NOT NULL CHECK (tier IN ('haiku', 'sonnet', 'opus')),
  model_id       text NOT NULL,
  escalate_to    text CHECK (escalate_to IN ('haiku', 'sonnet', 'opus')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- append-only rules
CREATE TRIGGER charging_versions_immutable      BEFORE UPDATE OR DELETE ON charging_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER charging_components_immutable    BEFORE UPDATE OR DELETE ON charging_components
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER charging_confirmations_immutable BEFORE UPDATE OR DELETE ON charging_confirmations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER provider_funding_immutable       BEFORE UPDATE OR DELETE ON provider_funding_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER credit_entries_immutable         BEFORE UPDATE OR DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER call_events_immutable            BEFORE UPDATE OR DELETE ON call_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_immutable              BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------- privileges + RLS
-- Internal staff: full access to every table.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
GRANT EXECUTE ON FUNCTION ensure_call_events_partition(date) TO voicelab_internal;

-- Clients: read their own projects and their own credit ledger. Nothing else.
-- In particular no privilege on providers, charging_*, provider_funding_entries
-- or call_events, so provider cost and margin are unreachable from this role.
GRANT SELECT ON projects, credit_entries TO voicelab_client;

ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_internal ON projects       FOR ALL    TO voicelab_internal USING (true) WITH CHECK (true);
CREATE POLICY credits_internal  ON credit_entries FOR ALL    TO voicelab_internal USING (true) WITH CHECK (true);
CREATE POLICY projects_tenant   ON projects       FOR SELECT TO voicelab_client
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY credits_tenant    ON credit_entries FOR SELECT TO voicelab_client
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
