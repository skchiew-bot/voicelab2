-- Control Tower panels and the change log read recent rows of large, growing tables on every refresh. These indexes
-- let them read only the window they show instead of the whole table.
CREATE INDEX workflow_run_steps_type_time_idx ON workflow_run_steps (type, created_at);
CREATE INDEX audit_log_action_idx ON audit_log (action text_pattern_ops, id);
CREATE INDEX appointment_events_kind_time_idx ON appointment_events (kind, at);
CREATE INDEX did_failures_time_idx ON did_failures (created_at);
