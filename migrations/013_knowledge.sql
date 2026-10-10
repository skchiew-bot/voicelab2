-- Phase 7, module 3: the knowledge base and policy. Knowledge informs the bot; policy governs what it may do and say.
-- Both are scoped to one client. Knowledge needs one reviewer; a policy change needs every approval level, each by a
-- different person, and goes live only when someone other than its proposer puts it live.

CREATE TABLE knowledge_articles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  slug       text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_-]{0,60}$'),
  language   text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_id, slug, language)
);

-- What an article says, version by version. The words never change once written; only the review status does.
CREATE FUNCTION knowledge_articles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'knowledge articles are append-only'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.slug IS DISTINCT FROM OLD.slug OR NEW.language IS DISTINCT FROM OLD.language OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'an article keeps its identity, and a retired one stays retired';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_articles_guard BEFORE UPDATE OR DELETE ON knowledge_articles FOR EACH ROW EXECUTE FUNCTION knowledge_articles_guard();

CREATE TABLE knowledge_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  uuid NOT NULL REFERENCES knowledge_articles(id),
  version     integer NOT NULL CHECK (version >= 1),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  voice_text  text CHECK (voice_text IS NULL OR length(voice_text) BETWEEN 1 AND 600),   -- the short form to speak; else one is derived
  tags        text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'rejected', 'retired')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  UNIQUE (article_id, version)
);
CREATE UNIQUE INDEX knowledge_one_published ON knowledge_versions (article_id) WHERE status = 'published';

CREATE FUNCTION knowledge_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'knowledge versions are append-only'; END IF;
  IF NEW.article_id IS DISTINCT FROM OLD.article_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.voice_text IS DISTINCT FROM OLD.voice_text OR NEW.tags IS DISTINCT FROM OLD.tags OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a knowledge version says is append-only; only its review status changes';
  END IF;
  -- Who reviewed it is kept once written, and a version only moves forward: draft, then published or rejected, then retired.
  IF OLD.reviewed_by IS NOT NULL AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note) THEN
    RAISE EXCEPTION 'who reviewed a knowledge version is kept for good';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'rejected', 'retired')) OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'a knowledge version cannot go from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_versions_guard BEFORE UPDATE OR DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION knowledge_versions_guard();

-- How many levels of approval a policy change needs, in order. At least two: a policy is never settled by one pair of eyes.
CREATE TABLE policy_levels (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  levels     text[] NOT NULL CHECK (cardinality(levels) BETWEEN 2 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A version of a client's policy: rules about what the bot may do (actions) and may never say (phrases).
CREATE TABLE policy_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  major         integer NOT NULL CHECK (major >= 1),
  minor         integer NOT NULL CHECK (minor >= 0),
  rules         jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 100),
  summary       text NOT NULL CHECK (btrim(summary) <> ''),
  diff          jsonb NOT NULL DEFAULT '[]',
  from_version_id uuid REFERENCES policy_versions(id),
  rollback_of   uuid REFERENCES policy_versions(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'live', 'retired', 'rejected', 'withdrawn')),
  proposed_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_by  uuid REFERENCES users(id),
  activated_at  timestamptz,
  withdrawn_by  uuid REFERENCES users(id),
  withdrawn_at  timestamptz,
  withdrawn_note text,
  levels_at_proposal text[] NOT NULL CHECK (cardinality(levels_at_proposal) BETWEEN 2 AND 5)
);
-- A version number is taken only by a version that was not turned down or withdrawn, so a refused 2.0 does not hold the number.
CREATE UNIQUE INDEX policy_version_number ON policy_versions (tenant_id, major, minor) WHERE status NOT IN ('rejected', 'withdrawn');
CREATE UNIQUE INDEX policy_one_live ON policy_versions (tenant_id) WHERE status = 'live';
CREATE UNIQUE INDEX policy_one_pending ON policy_versions (tenant_id) WHERE status IN ('pending', 'approved');

CREATE FUNCTION policy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policy versions are append-only'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.major IS DISTINCT FROM OLD.major OR NEW.minor IS DISTINCT FROM OLD.minor OR NEW.rules IS DISTINCT FROM OLD.rules
     OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.diff IS DISTINCT FROM OLD.diff OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.from_version_id IS DISTINCT FROM OLD.from_version_id OR NEW.rollback_of IS DISTINCT FROM OLD.rollback_of THEN
    RAISE EXCEPTION 'what a policy version says is append-only; only its status changes';
  END IF;
  IF NEW.levels_at_proposal IS DISTINCT FROM OLD.levels_at_proposal
     OR (OLD.activated_by IS NOT NULL AND (NEW.activated_by IS DISTINCT FROM OLD.activated_by OR NEW.activated_at IS DISTINCT FROM OLD.activated_at))
     OR (OLD.withdrawn_by IS NOT NULL AND (NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_note IS DISTINCT FROM OLD.withdrawn_note)) THEN
    RAISE EXCEPTION 'who put a policy live or withdrew it, and the levels it was proposed under, are kept for good';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'withdrawn')) OR (OLD.status = 'approved' AND NEW.status IN ('live', 'withdrawn')) OR (OLD.status = 'live' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'a policy version cannot go from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_versions_guard BEFORE UPDATE OR DELETE ON policy_versions FOR EACH ROW EXECUTE FUNCTION policy_versions_guard();

-- One decision per level, kept for good.
CREATE TABLE policy_approvals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id  uuid NOT NULL REFERENCES policy_versions(id),
  level       integer NOT NULL CHECK (level >= 0),
  decision    text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note        text,
  decided_by  uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, level)
);
CREATE TRIGGER policy_approvals_immutable BEFORE UPDATE OR DELETE ON policy_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every question put to the policy and what it answered. No call variables are kept, only the action and the verdict.
CREATE TABLE policy_decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  version_id  uuid REFERENCES policy_versions(id),
  action      text NOT NULL,
  allowed     boolean NOT NULL,
  rule_id     text,
  reason      text NOT NULL,
  call_id     uuid,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decisions_idx ON policy_decisions (tenant_id, at DESC);
CREATE TRIGGER policy_decisions_immutable BEFORE UPDATE OR DELETE ON policy_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
