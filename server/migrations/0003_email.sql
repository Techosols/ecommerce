-- 0003_email.sql
-- Phase 1. Durable mail outbox and suppression list (§10.1, §10.4).
-- Forward-only. Never edit a migration that has been applied (§4.4).

CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY,
  to_email            citext NOT NULL,
  from_email          citext NOT NULL,
  reply_to            citext,
  template            text NOT NULL,
  subject             text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}',
  category            text NOT NULL DEFAULT 'transactional'
                        CHECK (category IN ('transactional', 'marketing')),
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  provider            text,
  provider_message_id text,
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          text,
  dedupe_key          text UNIQUE,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_messages_recipient_idx ON email_messages (to_email, created_at DESC);
CREATE INDEX email_messages_failed_idx ON email_messages (created_at DESC) WHERE status = 'failed';

COMMENT ON TABLE email_messages IS
  'One row per message, written before the job is queued: mail outbox, audit trail and dedupe in one.';
COMMENT ON COLUMN email_messages.dedupe_key IS
  'Deterministic key (e.g. order.placed:<orderId>:<userId>) making a retried job a no-op.';

CREATE TABLE email_suppressions (
  email      citext PRIMARY KEY,
  reason     text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE email_suppressions IS
  'Addresses we must not send to. Consulted before every send; a hit is "suppressed", not a failure.';
