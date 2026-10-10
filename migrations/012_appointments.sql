-- Phase 7, module 2: appointments. Diaries for individual officers or groups of them; a customer comes to a fixed
-- location or an officer goes to the customer; a delay moves every later appointment; changes are told to the people
-- they touch by messages the client's own sender delivers. Customers are known by the client's reference only.

CREATE TABLE locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  address    text NOT NULL CHECK (length(address) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- An individual officer's diary, or a group diary whose members are individual diaries. A group booking goes to a member.
CREATE TABLE diaries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind        text NOT NULL CHECK (kind IN ('individual', 'group')),
  officer_ref text CHECK (length(officer_ref) <= 200),           -- the client's own reference for the officer
  officer_channel text NOT NULL DEFAULT 'whatsapp' CHECK (officer_channel IN ('whatsapp', 'sms', 'email')),
  time_zone   text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK ((kind = 'individual') = (officer_ref IS NOT NULL))
);
CREATE TABLE diary_members (
  group_id  uuid NOT NULL REFERENCES diaries(id),
  member_id uuid NOT NULL REFERENCES diaries(id),
  PRIMARY KEY (group_id, member_id),
  CHECK (group_id <> member_id)
);
-- When an individual diary is open for appointments, by day of the week (0 = Sunday), in the diary's time zone.
CREATE TABLE diary_hours (
  diary_id uuid NOT NULL REFERENCES diaries(id),
  dow      smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
  starts   text NOT NULL CHECK (starts ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ends     text NOT NULL CHECK (ends ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  PRIMARY KEY (diary_id, dow),
  CHECK (starts < ends)
);
-- Time off and other times a diary cannot be booked.
CREATE TABLE diary_blocks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diary_id  uuid NOT NULL REFERENCES diaries(id),
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  reason    text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  CHECK (starts_at < ends_at)
);

-- What a client charges for cancelling late or not turning up. Amounts are exact decimals in the client's currency.
CREATE TABLE cancellation_policy (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  free_until_hours   integer NOT NULL DEFAULT 24 CHECK (free_until_hours BETWEEN 0 AND 720),
  late_fee           numeric(24,8) NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
  no_show_fee        numeric(24,8) NOT NULL DEFAULT 0 CHECK (no_show_fee >= 0),
  currency           char(3) NOT NULL DEFAULT 'MYR',
  reminder_hours     integer NOT NULL DEFAULT 24 CHECK (reminder_hours BETWEEN 1 AND 336),
  customer_channel   text NOT NULL DEFAULT 'whatsapp' CHECK (customer_channel IN ('whatsapp', 'sms', 'email')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  diary_id         uuid NOT NULL REFERENCES diaries(id),         -- always an individual diary: a group booking is placed on a member
  booked_via       uuid REFERENCES diaries(id),
  case_id          uuid,
  contact_ref      text NOT NULL CHECK (length(contact_ref) BETWEEN 1 AND 200),
  customer_channel text NOT NULL CHECK (customer_channel IN ('whatsapp', 'sms', 'email')),
  kind             text NOT NULL CHECK (kind IN ('at_location', 'field_visit')),
  location_id      uuid REFERENCES locations(id),
  visit_address    text CHECK (length(visit_address) <= 300),
  travel_minutes   integer NOT NULL DEFAULT 0 CHECK (travel_minutes BETWEEN 0 AND 600),   -- the officer needs this long to get here from the last appointment
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  original_starts_at timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show', 'rescheduled', 'needs_reschedule')),
  cancelled_by     text CHECK (cancelled_by IN ('customer', 'officer', 'client')),
  cancel_reason    text,
  fee              numeric(24,8) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  fee_reason       text,
  replaces_id      uuid REFERENCES appointments(id),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK ((kind = 'at_location') = (location_id IS NOT NULL)),
  CHECK ((kind = 'field_visit') = (visit_address IS NOT NULL))
);
CREATE INDEX appointments_diary_idx ON appointments (diary_id, starts_at) WHERE status IN ('booked', 'needs_reschedule');
CREATE INDEX appointments_contact_idx ON appointments (tenant_id, contact_ref);

CREATE TABLE appointment_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  kind           text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  actor_id       uuid REFERENCES users(id),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_events_idx ON appointment_events (appointment_id, id);
CREATE TRIGGER appointment_events_immutable BEFORE UPDATE OR DELETE ON appointment_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Messages for people, by the channel each prefers. The platform writes them; the client's own sender delivers them
-- (the platform has no SMS, WhatsApp or email provider) and marks them. The text and who it is for never change.
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('customer', 'officer')),
  recipient_ref  text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  kind           text NOT NULL,
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 600),
  dedupe_key     text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  marked_at      timestamptz
);
-- Only the delivery status may change: who a message is for, and what it says, never do.
CREATE FUNCTION notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind
     OR NEW.recipient_ref IS DISTINCT FROM OLD.recipient_ref OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a notification''s text and recipient are append-only; only its status changes';
  END IF;
  RETURN NEW;
END $$;
CREATE INDEX notifications_pending_idx ON notifications (tenant_id, created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (appointment_id, recipient_kind, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TRIGGER notifications_guard BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_guard();
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
