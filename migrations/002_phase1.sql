-- Phase 1: credential checks, FX, client rate card, per-call cost records, do-not-call gate.

ALTER TABLE providers ADD COLUMN credentials_checked_at timestamptz;

-- More ways to state a rate: providers quote tokens and characters per thousand or million.
ALTER TABLE charging_components DROP CONSTRAINT charging_components_unit_check;
ALTER TABLE charging_components ADD CONSTRAINT charging_components_unit_check CHECK (unit IN
  ('per_minute', 'per_second', 'per_character', 'per_1k_characters', 'per_token',
   'per_1k_tokens', 'per_1m_tokens', 'per_credit', 'flat'));

-- ------------------------------------------------------------------- FX
-- Units of a currency per 1 USD (so MYR 4.5 means 1 USD = 4.5 MYR). USD is implicit 1.
-- Versioned: a cost record stores the rate it used, so history never changes.
CREATE TABLE fx_rates (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  currency        char(3) NOT NULL CHECK (currency <> 'USD'),
  per_usd         numeric(18,8) NOT NULL CHECK (per_usd > 0),
  effective_from  timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, effective_from)
);

-- ------------------------------------------------------ client rate card
-- Credits read zero until a rate card exists. The meter mirrors the provider's
-- billing increment, so these are per billed minute, not per actual minute.
CREATE TABLE rate_cards (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effective_from               timestamptz NOT NULL UNIQUE,
  inbound_credits_per_minute   numeric(18,4) NOT NULL CHECK (inbound_credits_per_minute >= 0),
  outbound_credits_per_minute  numeric(18,4) NOT NULL CHECK (outbound_credits_per_minute >= 0),
  credit_value_usd             numeric(18,8) NOT NULL CHECK (credit_value_usd >= 0),
  created_at                   timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- per-call costs
-- Internal only: this is provider cost and margin. Clients see only the credits
-- drawn, through credit_entries.
CREATE TABLE call_costs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           uuid NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  project_id        uuid REFERENCES projects(id),
  direction         text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  occurred_at       timestamptz NOT NULL,
  -- estimated until it is checked against the provider's own usage data
  status            text NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated', 'reconciled')),
  total_usd         numeric(18,8) NOT NULL,
  myr_per_usd       numeric(18,8) NOT NULL,
  total_myr         numeric(18,8) NOT NULL,
  credits_drawn     numeric(18,4) NOT NULL DEFAULT 0,
  credit_value_usd  numeric(18,8) NOT NULL DEFAULT 0,
  margin_usd        numeric(18,8) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, status)
);
CREATE INDEX call_costs_project_idx ON call_costs (project_id, occurred_at);
CREATE INDEX call_costs_tenant_idx  ON call_costs (tenant_id, occurred_at);

CREATE TABLE call_cost_lines (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_cost_id         uuid NOT NULL REFERENCES call_costs(id),
  provider_id          uuid NOT NULL REFERENCES providers(id),
  -- the exact rate version used, so a later rate change cannot alter this record
  charging_version_id  uuid NOT NULL REFERENCES charging_versions(id),
  component            text NOT NULL,
  billing_line         text NOT NULL,
  unit                 text NOT NULL,
  quantity             text NOT NULL,
  billed_seconds       integer,
  rate                 numeric(18,8) NOT NULL,
  currency             char(3) NOT NULL,
  burst_multiplier     numeric(6,3),
  amount               numeric(18,8) NOT NULL,
  per_usd              numeric(18,8) NOT NULL,
  amount_usd           numeric(18,8) NOT NULL
);
CREATE INDEX call_cost_lines_cost_idx ON call_cost_lines (call_cost_id);

-- --------------------------------------------------------- do-not-call gate
-- A country must be declared before anything is dialled there: either a registry
-- is in force, or an operator has explicitly recorded that none is required.
-- Numbers are stored as keyed hashes, never in clear.
CREATE TABLE dnc_registries (
  country          char(2) PRIMARY KEY,
  requirement      text NOT NULL CHECK (requirement IN ('registry', 'none_required')),
  source           text NOT NULL,
  declared_by      uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dnc_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country      char(2) NOT NULL REFERENCES dnc_registries(country),
  -- NULL: national registry. Set: a client's own opt-out list.
  tenant_id    uuid REFERENCES tenants(id),
  number_hash  text NOT NULL,
  source       text,
  added_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dnc_entries_unique ON dnc_entries
  (country, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), number_hash);

-- ------------------------------------------------------------ append-only
CREATE TRIGGER fx_rates_immutable         BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER rate_cards_immutable       BEFORE UPDATE OR DELETE ON rate_cards
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER call_costs_immutable       BEFORE UPDATE OR DELETE ON call_costs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER call_cost_lines_immutable  BEFORE UPDATE OR DELETE ON call_cost_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- privileges
-- Internal staff only. The client role gets nothing new: provider cost, margin,
-- FX and the do-not-call lists stay unreachable from it.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
