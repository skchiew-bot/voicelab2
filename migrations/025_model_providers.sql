-- A model provider: the AI models a call uses are priced like any other provider, by dated rate versions (input and
-- output tokens), so a price change is a new version and calls already costed keep their rate.
-- Written to be safe on a database that ran this migration under an earlier number while the branch was open.
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_kind_check;
ALTER TABLE providers ADD CONSTRAINT providers_kind_check CHECK (kind IN ('telephony', 'voice', 'model'));
-- One provider per model id, so a decision's tokens are always priced by one known rate.
CREATE UNIQUE INDEX IF NOT EXISTS providers_one_per_model ON providers ((params->>'model')) WHERE kind = 'model';
