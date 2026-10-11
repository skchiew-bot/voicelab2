-- Provider funding is drawn down as calls are costed (Phase 4).
-- Amounts carry the cost record's eight decimal places, so a call's deduction equals what it cost exactly; widening the
-- column from six places changes no amount already recorded.
ALTER TABLE provider_funding_entries ALTER COLUMN amount TYPE numeric(20,8);

-- The call a usage entry was drawn down for (null for entries a person records). A call is drawn down once per
-- provider and currency.
ALTER TABLE provider_funding_entries ADD COLUMN call_id uuid;
CREATE UNIQUE INDEX provider_funding_once_per_call ON provider_funding_entries (call_id, provider_id, currency) WHERE call_id IS NOT NULL;

-- Every costed call now reads a provider's balance (to see whether it is kept, and whether it has run out), and the ledger
-- grows by a row per call, so the balance is read by provider and currency from an index, not by scanning the ledger.
CREATE INDEX provider_funding_by_provider ON provider_funding_entries (provider_id, currency) INCLUDE (amount);
