-- Phase 6: the self-learning promotion loop. A dynamic line that keeps coming out the same is distilled into one script,
-- reviewed, recorded and promoted; live monitoring demotes it if it drifts. Everything here is internal.

-- How a client's loop is tuned. Defaults are conservative; a missing row means the defaults.
CREATE TABLE learning_config (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id),
  min_support          integer NOT NULL DEFAULT 20 CHECK (min_support BETWEEN 2 AND 100000),      -- frequency threshold
  similarity           numeric(3,2) NOT NULL DEFAULT 0.60 CHECK (similarity BETWEEN 0.30 AND 1),
  min_confidence       numeric(3,2) NOT NULL DEFAULT 0.85 CHECK (min_confidence BETWEEN 0.50 AND 1),
  drift_min_samples    integer NOT NULL DEFAULT 20 CHECK (drift_min_samples BETWEEN 3 AND 100000),
  drift_sentiment_drop numeric(3,2) NOT NULL DEFAULT 0.30 CHECK (drift_sentiment_drop BETWEEN 0.05 AND 2),
  drift_unheard_rise   numeric(3,2) NOT NULL DEFAULT 0.20 CHECK (drift_unheard_rise BETWEEN 0.05 AND 1),
  drift_escalation_rise numeric(3,2) NOT NULL DEFAULT 0.15 CHECK (drift_escalation_rise BETWEEN 0.05 AND 1),
  voice_provider_id    uuid REFERENCES providers(id),                                              -- prices the assessment
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Every dynamic line a call spoke, with the context it was said in. Slots are marked; nothing sensitive is ever here.
CREATE TABLE learning_turns (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  run_id       uuid NOT NULL,
  call_id      uuid,
  workflow     text NOT NULL,
  node         text NOT NULL,
  language     text NOT NULL,
  context_kind text NOT NULL,
  context_topic text NOT NULL DEFAULT '',
  text         text NOT NULL,                 -- the line with the values of known variables put back as {{slots}}
  synth_chars  integer NOT NULL CHECK (synth_chars >= 0),
  slot_chars   integer NOT NULL CHECK (slot_chars >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_turns_node_idx ON learning_turns (tenant_id, workflow, node, language, created_at);
CREATE TRIGGER learning_turns_immutable BEFORE UPDATE OR DELETE ON learning_turns FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A script distilled from a cluster of turns. Never edited: a new script is a new row that supersedes the old one.
CREATE TABLE promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  workflow       text NOT NULL,
  node           text NOT NULL,
  language       text NOT NULL,
  context_kind   text NOT NULL,
  context_topic  text NOT NULL DEFAULT '',
  script         text NOT NULL CHECK (btrim(script) <> ''),
  slots          text[] NOT NULL DEFAULT '{}',
  support        integer NOT NULL CHECK (support >= 1),      -- turns the cluster rests on
  variants       integer NOT NULL CHECK (variants >= 1),     -- different wordings in it
  avg_synth_chars numeric(10,2) NOT NULL,                    -- what the node costs per use while it is live
  avg_slot_chars  numeric(10,2) NOT NULL,                    -- the part that stays live after promotion
  node_hash      text NOT NULL,                              -- the node as defined when the script was made
  distilled_by   text NOT NULL,                              -- 'rules' or a model id
  supersedes     uuid REFERENCES promotions(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotions_node_idx ON promotions (tenant_id, workflow, node, language, created_at DESC);
CREATE TRIGGER promotions_immutable BEFORE UPDATE OR DELETE ON promotions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Everything that happens to a script, in order. Its status is the latest of these.
CREATE TABLE promotion_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id  uuid NOT NULL REFERENCES promotions(id),
  kind          text NOT NULL CHECK (kind IN ('distilled', 'reviewed', 'approved', 'rejected', 'recorded', 'promoted', 'drift_detected', 'demoted', 'regenerated')),
  actor_id      uuid REFERENCES users(id),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotion_events_idx ON promotion_events (promotion_id, id);
CREATE TRIGGER promotion_events_immutable BEFORE UPDATE OR DELETE ON promotion_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voicelab_internal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO voicelab_internal;
