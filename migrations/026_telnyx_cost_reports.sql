-- Telnyx reports each call's cost in a signed `call.cost` webhook, not through an API we can ask (Phase 1). Each verified
-- report is kept here, append-only, and reconciliation reads the latest one. Internal only: what a provider charged is
-- never shown to a client.
CREATE TABLE IF NOT EXISTS provider_cost_reports (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id   uuid NOT NULL REFERENCES providers(id),
  call_id       uuid NOT NULL,
  -- 'ready': the provider priced the call; 'error': it says it could not.
  status        text NOT NULL CHECK (status IN ('ready', 'error')),
  -- The provider's billed seconds (the longest billed part), when it gave them.
  billed_seconds integer CHECK (billed_seconds >= 0),
  -- What it charged, one entry per currency: [{"cost": "0.0106", "currency": "USD"}]. Exact decimal strings.
  amounts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at   timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_cost_reports_call ON provider_cost_reports (call_id, id);

DROP TRIGGER IF EXISTS provider_cost_reports_immutable ON provider_cost_reports;
CREATE TRIGGER provider_cost_reports_immutable BEFORE UPDATE OR DELETE ON provider_cost_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON provider_cost_reports TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
