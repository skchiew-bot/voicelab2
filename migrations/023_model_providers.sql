-- A model provider: the AI models a call uses are priced like any other provider, by dated rate versions (input and
-- output tokens), so a price change is a new version and calls already costed keep their rate.
ALTER TABLE providers DROP CONSTRAINT providers_kind_check;
ALTER TABLE providers ADD CONSTRAINT providers_kind_check CHECK (kind IN ('telephony', 'voice', 'model'));
