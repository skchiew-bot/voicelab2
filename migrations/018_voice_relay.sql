-- The live call voice link (Twilio speech relay). A call carries the workflow it runs once answered; one of our own
-- numbers can say which workflow answers it. The workflow must belong to the same client (checked by the API).

ALTER TABLE calls ADD COLUMN workflow_id uuid REFERENCES workflows(id);
ALTER TABLE phone_numbers ADD COLUMN inbound_workflow_id uuid REFERENCES workflows(id);

-- One live conversation per call: a second connection for the same call (a reconnect, a retried request) carries on the
-- run already under way instead of starting the workflow again.
CREATE UNIQUE INDEX workflow_runs_one_live_per_call ON workflow_runs (call_id) WHERE kind = 'live' AND call_id IS NOT NULL;

-- Which relay connection serves the call now. A new connection (a reconnect) takes the call over; only the connection
-- that holds it may end its run when it closes, so a stale connection closing never ends a call another is serving.
ALTER TABLE calls ADD COLUMN relay_owner uuid;
ALTER TABLE calls ADD COLUMN relay_claimed_at timestamptz;
-- Set once the relay has fallen back on this call (callback recorded, holding line said), so a reconnect does not
-- record a second callback request or start the workflow again.
ALTER TABLE calls ADD COLUMN relay_failed boolean NOT NULL DEFAULT false;
