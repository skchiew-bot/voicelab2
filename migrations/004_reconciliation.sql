-- Phase 1 completion: direction-specific rates, reconciliation against provider data.

-- Providers charge inbound and outbound differently (the blueprint's reference rates do).
-- 'any' keeps every existing rate meaning what it did.
ALTER TABLE charging_components
  ADD COLUMN direction text NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'inbound', 'outbound'));

ALTER TABLE calls DROP CONSTRAINT calls_cost_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_cost_status_check
  CHECK (cost_status IN ('pending', 'recorded', 'failed', 'reconciled', 'variance'));

-- Each check of a call's estimated cost against what the provider says it charged.
CREATE TABLE call_reconciliations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id             uuid NOT NULL,
  provider_id         uuid NOT NULL REFERENCES providers(id),
  source              text NOT NULL CHECK (source IN ('provider_api', 'manual')),
  outcome             text NOT NULL CHECK (outcome IN ('matched', 'variance')),
  tolerance_pct       numeric(6,2) NOT NULL,
  our_seconds         numeric(10,3),
  reported_seconds    numeric(10,3),
  our_cost_usd        numeric(18,8) NOT NULL,
  reported_cost_usd   numeric(18,8),
  detail              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_reconciliations_call_idx ON call_reconciliations (call_id);

CREATE TRIGGER call_reconciliations_immutable BEFORE UPDATE OR DELETE ON call_reconciliations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
