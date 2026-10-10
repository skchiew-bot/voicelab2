-- Phase 0: finer staff roles and switching a user off.
-- internal_viewer is Daythree staff who may look at everything internal but change nothing: the API refuses
-- anything but a read, and the database transaction it runs in is read-only.
-- A user can be disabled (their token stops working), never re-enabled or deleted, so who could act, and when,
-- stays on record. Nothing else about a user changes after it is created.

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('internal_admin', 'internal_viewer', 'tenant_admin', 'tenant_user')),
  ADD CONSTRAINT users_staff_have_no_tenant CHECK ((role IN ('internal_admin', 'internal_viewer')) = (tenant_id IS NULL)),
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by uuid REFERENCES users(id),
  ADD CONSTRAINT users_disabled_together CHECK ((disabled_at IS NULL) = (disabled_by IS NULL));

CREATE FUNCTION users_only_disable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'users are disabled, never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.disabled_at IS NOT NULL
     OR NEW.disabled_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.email, NEW.role, NEW.token_hash, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.email, OLD.role, OLD.token_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'a user can only be disabled, once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_only_disable BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_only_disable();
