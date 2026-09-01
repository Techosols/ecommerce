-- 0005_audit.sql
-- Administrative audit trail (§15.7, §43).
-- Forward-only. Never edit a migration that has been applied (§4.4).

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_logs — what a human with power did, and to what.
--
-- Deliberately distinct from application logs: logs are for operators and are
-- ephemeral; this is for the business, is queryable from the admin UI, and is
-- retained. It is also written *inside* the business transaction — if the
-- change committed, its audit record committed with it. An asynchronous audit
-- trail can lose exactly the record that matters.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Snapshot, so the trail survives the actor's account being deleted.
  actor_email   citext,
  actor_roles   text[] NOT NULL DEFAULT '{}',
  actor_ip      inet,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  resource_type text NOT NULL,
  resource_id   text,
  before        jsonb,
  after         jsonb,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

COMMENT ON TABLE audit_logs IS
  'Append-only record of administrative actions. Written in the same transaction as the change.';
COMMENT ON COLUMN audit_logs.action IS 'resource.verb_past_tense, e.g. settings.updated.';
COMMENT ON COLUMN audit_logs.before IS
  'The changed fields only, as they were. NULL for a creation.';
COMMENT ON COLUMN audit_logs.after IS
  'The changed fields only, as they now are. NULL for a deletion.';
