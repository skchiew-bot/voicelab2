-- Phase 0: the client portal. A client's users see their own calls and credits, and a client admin manages the
-- client's own users. Everything here is read and written as the voicelab_client role, scoped to the tenant set by
-- withActor (app.tenant_id): the role still has no grant on calls, call costs, providers or users.
--
-- What a client may see of a call: when, which way, how it went, how long, the outcome recorded, and the credits it
-- drew (from the client's own credit ledger, the figure already shown to them). Never the provider, provider cost,
-- margin, the provider's call id or end reason, or anything about another client.

CREATE VIEW client_calls WITH (security_barrier) AS
  SELECT c.id, c.project_id, p.name AS project, c.direction, c.status, c.started_at, c.answered_at, c.ended_at,
         c.duration_seconds,
         (SELECT o.outcome FROM outbound_outcomes o WHERE o.call_id = c.id ORDER BY o.id DESC LIMIT 1) AS outcome,
         coalesce((SELECT -sum(e.credits) FROM credit_entries e WHERE e.tenant_id = c.tenant_id AND e.ref = 'call:' || c.id::text), 0)::numeric(18,4) AS credits_drawn
    FROM calls c LEFT JOIN projects p ON p.id = c.project_id
   WHERE c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;

CREATE VIEW client_users WITH (security_barrier) AS
  SELECT id, email, role, created_at, disabled_at
    FROM users
   WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;

GRANT SELECT ON client_calls, client_users TO voicelab_client;
CREATE INDEX credit_entries_ref_idx ON credit_entries (tenant_id, ref);

-- A client admin adds or disables users of their own client, and only of their own client. The tenant comes from the
-- session (app.tenant_id), never from the caller; the person acting is checked inside, under one lock per client.
CREATE FUNCTION client_add_user(p_actor uuid, p_email text, p_role text, p_token_hash text)
  RETURNS TABLE (id uuid, email text, role text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid := nullif(current_setting('app.tenant_id', true), '')::uuid; u users;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no client' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('client-users:' || t::text));
  IF NOT EXISTS (SELECT 1 FROM users a WHERE a.id = p_actor AND a.tenant_id = t AND a.role = 'tenant_admin' AND a.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'only an active client admin can add users' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('tenant_admin', 'tenant_user') THEN RAISE EXCEPTION 'not a client role' USING ERRCODE = '22023'; END IF;
  INSERT INTO users (tenant_id, email, role, token_hash, created_by) VALUES (t, lower(trim(p_email)), p_role, p_token_hash, p_actor) RETURNING * INTO u;
  INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (p_actor, 'user.create', 'user', u.id::text, jsonb_build_object('role', u.role, 'by', 'client'));
  RETURN QUERY SELECT u.id, u.email, u.role;
END $$;

CREATE FUNCTION client_disable_user(p_actor uuid, p_user uuid)
  RETURNS TABLE (id uuid, email text, role text, disabled_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid := nullif(current_setting('app.tenant_id', true), '')::uuid; u users;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no client' USING ERRCODE = '42501'; END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'you cannot disable yourself' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('client-users:' || t::text));
  IF NOT EXISTS (SELECT 1 FROM users a WHERE a.id = p_actor AND a.tenant_id = t AND a.role = 'tenant_admin' AND a.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'only an active client admin can disable users' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO u FROM users x WHERE x.id = p_user AND x.tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such user' USING ERRCODE = 'P0003'; END IF;
  IF u.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'already disabled' USING ERRCODE = 'P0004'; END IF;
  UPDATE users x SET disabled_at = now(), disabled_by = p_actor WHERE x.id = p_user RETURNING * INTO u;
  INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (p_actor, 'user.disable', 'user', u.id::text, jsonb_build_object('role', u.role, 'by', 'client'));
  RETURN QUERY SELECT u.id, u.email, u.role, u.disabled_at;
END $$;

REVOKE ALL ON FUNCTION client_add_user(uuid, text, text, text), client_disable_user(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION client_add_user(uuid, text, text, text), client_disable_user(uuid, uuid) TO voicelab_client;
