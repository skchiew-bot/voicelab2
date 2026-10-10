-- Control Tower alerts by email (the owner's chosen channel, 2026-10-10). Alerts are still derived from live state, not
-- stored; what is stored is which alerts are open, who should hear about them, and every email sent.

-- Who gets which alerts. Only Daythree staff (the alerts name providers, costs and funding, which clients never see).
CREATE TABLE alert_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  min_severity  text NOT NULL CHECK (min_severity IN ('high', 'medium', 'low')),
  codes         text[],                                  -- null: every kind of alert
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  UNIQUE (user_id)
);

-- An alert that is showing now. Its key is what it is about (the kind and where it points), so a changing count does
-- not make it new. Cleared when it stops showing; if it comes back it is new again and sent again.
CREATE TABLE alert_state (
  key           text PRIMARY KEY,
  code          text NOT NULL,
  severity      text NOT NULL,
  message       text NOT NULL,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  cleared_at    timestamptz,
  episode       integer NOT NULL DEFAULT 1
);

-- Every email Voice Lab tried to send. One per alert episode and person. Kept for good.
CREATE TABLE alert_deliveries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_key     text NOT NULL,
  episode       integer NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('alert', 'test')),
  status        text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown', 'no_mail_service')),
  detail        text,                                    -- a category, never a mail server's own text
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  UNIQUE (alert_key, episode, user_id, kind)
);
CREATE INDEX alert_deliveries_recent_idx ON alert_deliveries (created_at DESC);
CREATE FUNCTION alert_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'alert deliveries are append-only'; END IF;
  IF OLD.status <> 'sending' OR NEW.alert_key IS DISTINCT FROM OLD.alert_key OR NEW.episode IS DISTINCT FROM OLD.episode
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an alert delivery is settled once and then kept as it is';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_deliveries_guard BEFORE UPDATE OR DELETE ON alert_deliveries FOR EACH ROW EXECUTE FUNCTION alert_deliveries_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
