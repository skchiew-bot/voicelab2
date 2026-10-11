-- A person can replace their own sign-in token. The token a user is given when someone adds them is shown to that
-- someone, so it proves nothing about who holds it; a token the holder replaced themselves is theirs alone. The time of
-- the last replacement is kept on the user, so a check that trusts a named person (PRODUCTION_DEPLOYERS) can tell the
-- two apart.
ALTER TABLE users ADD COLUMN token_rotated_at timestamptz;

-- A user's row still changes only by one approval and one disable, and now by replacing the token: the new hash and the
-- time it was replaced change together, at the moment of the change, and never for a disabled user.
CREATE OR REPLACE FUNCTION users_only_approve_or_disable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rotated boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'users are disabled, never deleted' USING ERRCODE = 'P0001';
  END IF;
  rotated := NEW.token_hash IS DISTINCT FROM OLD.token_hash;
  IF rotated AND (OLD.disabled_at IS NOT NULL OR NEW.token_rotated_at IS DISTINCT FROM now()) THEN
    RAISE EXCEPTION 'a token is replaced only by its active holder, and the time of it recorded' USING ERRCODE = 'P0001';
  END IF;
  IF NOT rotated AND NEW.token_rotated_at IS DISTINCT FROM OLD.token_rotated_at THEN
    RAISE EXCEPTION 'the time a token was replaced changes only with the token' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.email, NEW.role, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.email, OLD.role, OLD.created_at, OLD.created_by)
     OR (OLD.disabled_at IS NOT NULL AND (NEW.disabled_at, NEW.disabled_by) IS DISTINCT FROM (OLD.disabled_at, OLD.disabled_by))
     OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.approved_at, OLD.approved_by)) THEN
    RAISE EXCEPTION 'a user can only be approved once and disabled once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
