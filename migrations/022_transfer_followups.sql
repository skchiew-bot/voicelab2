-- Follow-ups to passing a live caller to a person (020).

-- How long the agent's leg lasted, as Twilio reports it when the dial ends (`DialCallDuration`). Twilio bills that leg
-- separately, so the call's one cost record carries it as its own line. Null until reported.
ALTER TABLE calls ADD COLUMN transfer_seconds numeric(10,3) CHECK (transfer_seconds >= 0);

-- Which leg of the call a cost line prices: the caller's own, or the agent's leg of a transfer. Reconciliation checks the
-- caller's leg against the provider's price for the call; the agent's leg is a separate provider call.
ALTER TABLE call_cost_lines ADD COLUMN leg text NOT NULL DEFAULT 'caller' CHECK (leg IN ('caller', 'agent'));

-- For now an agent number must be Malaysian (+60), and not one of Malaysia's special-rate or premium ranges (1-300,
-- 1-600, 1-700, 1-800, 1-900, 600), so a changed setting cannot send calls somewhere expensive (toll fraud). NOT VALID:
-- enforced for every new or changed setting; one already stored is refused at dial time.
ALTER TABLE transfer_settings ADD CONSTRAINT transfer_settings_agent_malaysian
  CHECK (agent_e164 ~ '^\+60[1-9][0-9]{7,9}$' AND agent_e164 !~ '^\+60(1[36789]00[0-9]{6}|600[0-9]+)$') NOT VALID;
