-- 0002_events_and_idempotency.sql
-- Phase 1. The transactional outbox (§12.1) and the idempotency store (§19).
-- Forward-only. Never edit a migration that has been applied (§4.4).

-- ─────────────────────────────────────────────────────────────────────────────
-- domain_events — event log AND outbox.
--
-- Rows are inserted inside the business transaction, so an event can never
-- exist for work that rolled back, and committed work can never lose its event.
-- The dispatcher claims undispatched rows with FOR UPDATE SKIP LOCKED.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE domain_events (
  id             bigserial PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE,
  name           text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  payload        jsonb NOT NULL,
  actor_user_id  uuid,
  request_id     text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text
);

-- Partial index: covers only undispatched rows, so the dispatcher's poll stays
-- a handful of pages no matter how large the event log grows (§5.12).
CREATE INDEX domain_events_undispatched_idx ON domain_events (id) WHERE dispatched_at IS NULL;
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX domain_events_name_idx ON domain_events (name, occurred_at DESC);

COMMENT ON TABLE domain_events IS
  'Transactional outbox and permanent ordered event log. Written inside the business transaction.';

-- ─────────────────────────────────────────────────────────────────────────────
-- idempotency_keys — replay store for unsafe requests (§19.2).
--
-- The UNIQUE constraint is the concurrency control: two simultaneous retries of
-- the same key cannot both execute the handler.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE idempotency_keys (
  id              bigserial PRIMARY KEY,
  key             text NOT NULL,
  scope           text NOT NULL,
  actor_key       text NOT NULL,
  request_hash    text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_status integer,
  response_body   jsonb,
  locked_at       timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  UNIQUE (key, scope, actor_key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

COMMENT ON TABLE idempotency_keys IS
  'Stores the response of a completed unsafe request so a retry replays it instead of repeating it.';
