-- Phase 0: finer staff roles, a second person for every new admin, and switching a user off.
-- internal_viewer is Daythree staff who may look at everything internal but change nothing: the API refuses
-- anything but a read, and the database transaction it runs in is read-only.
-- A new admin added by another admin cannot sign in until a different admin approves them; otherwise one admin
-- could mint a second identity and pass every "a different person must approve" rule alone. The first admin,
-- made by the installer, has no creator and needs no approval.
-- A user can be disabled (their token stops working), never re-enabled or deleted, so who could act, and when,
-- stays on record. Apart from that one approval and that one disable, nothing about a user changes.

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE users
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by uuid REFERENCES users(id),
  ADD CONSTRAINT users_role_check CHECK (role IN ('internal_admin', 'internal_viewer', 'tenant_admin', 'tenant_user')),
  ADD CONSTRAINT users_staff_have_no_tenant CHECK ((role IN ('internal_admin', 'internal_viewer')) = (tenant_id IS NULL)),
  ADD CONSTRAINT users_approved_together CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  ADD CONSTRAINT users_approved_by_another CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by),
  ADD CONSTRAINT users_disabled_together CHECK ((disabled_at IS NULL) = (disabled_by IS NULL));

-- An email is one person, whatever its case.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE FUNCTION users_only_approve_or_disable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'users are disabled, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.email, NEW.role, NEW.token_hash, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.email, OLD.role, OLD.token_hash, OLD.created_at, OLD.created_by)
     OR (OLD.disabled_at IS NOT NULL AND (NEW.disabled_at, NEW.disabled_by) IS DISTINCT FROM (OLD.disabled_at, OLD.disabled_by))
     OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.approved_at, OLD.approved_by)) THEN
    RAISE EXCEPTION 'a user can only be approved once and disabled once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_only_approve_or_disable BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_only_approve_or_disable();
