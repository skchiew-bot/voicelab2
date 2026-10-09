-- Control Tower: a status for calls that never connected, and indexes for the queries it runs every few seconds.

-- A dial that failed, or was blocked, never connected: there is nothing to price. That is not a pricing failure.
ALTER TABLE calls DROP CONSTRAINT calls_cost_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_cost_status_check
  CHECK (cost_status IN ('pending', 'recorded', 'failed', 'reconciled', 'variance', 'not_applicable'));
UPDATE calls SET cost_status = 'not_applicable', cost_error = NULL WHERE status = 'blocked' OR cost_error = 'never connected';

CREATE INDEX calls_provider_started_idx ON calls (provider_id, started_at);
CREATE INDEX calls_status_started_idx   ON calls (status, started_at);
CREATE INDEX calls_cost_attention_idx   ON calls (cost_status) WHERE cost_status IN ('pending', 'failed', 'variance');
CREATE INDEX call_costs_occurred_idx    ON call_costs (occurred_at);
