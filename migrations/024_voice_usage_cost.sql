-- What a model costs per million tokens, entered by an operator and dated like every other rate (owner's decision,
-- 2026-10-11). Append-only: a price change is a new row with a later start, so a call is always priced at the rate in
-- force when it started. Internal only: the client role gets nothing here.
CREATE TABLE model_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model           text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$'),
  effective_from  timestamptz NOT NULL,
  input_per_1m    numeric(18,8) NOT NULL CHECK (input_per_1m >= 0),
  output_per_1m   numeric(18,8) NOT NULL CHECK (output_per_1m >= 0),
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, effective_from)
);
CREATE TRIGGER model_rates_immutable BEFORE UPDATE OR DELETE ON model_rates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON model_rates TO voicelab_internal;

-- The voice provider whose per-character rate prices the speech on a telephony provider's live calls: the voice its
-- speech relay speaks with. Set by staff through its own audited route, and checked to be a voice provider then.
ALTER TABLE providers ADD COLUMN speech_provider_id uuid REFERENCES providers(id);
-- The voice provider a call's speech is priced at, fixed when the call is handed to the relay, so a later change of link
-- never re-prices a call that spoke with the earlier voice.
ALTER TABLE calls ADD COLUMN speech_provider_id uuid REFERENCES providers(id);

-- A cost line prices either a provider's usage at one of its charging versions (a call leg, the speech a voice provider
-- synthesised), or a model's tokens at one of its rates. Never both, never neither.
ALTER TABLE call_cost_lines ALTER COLUMN provider_id DROP NOT NULL;
ALTER TABLE call_cost_lines ALTER COLUMN charging_version_id DROP NOT NULL;
ALTER TABLE call_cost_lines ADD COLUMN model_rate_id uuid REFERENCES model_rates(id);
ALTER TABLE call_cost_lines ADD COLUMN model text;
ALTER TABLE call_cost_lines ADD CONSTRAINT call_cost_lines_one_source CHECK (
  (provider_id IS NOT NULL AND charging_version_id IS NOT NULL AND model_rate_id IS NULL AND model IS NULL)
  OR (provider_id IS NULL AND charging_version_id IS NULL AND model_rate_id IS NOT NULL AND model IS NOT NULL));
