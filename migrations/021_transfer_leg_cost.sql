-- The agent's leg of a transferred call is a call of its own at the provider: its id (never a number) and length, so it
-- is costed with the caller's call and checked against the provider's figures.
ALTER TABLE calls ADD COLUMN transfer_leg_sid text;
ALTER TABLE calls ADD COLUMN transfer_seconds numeric(10,3) CHECK (transfer_seconds >= 0);
