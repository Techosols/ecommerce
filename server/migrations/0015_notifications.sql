-- 0015_notifications.sql
-- In-app notifications and per-user channel preferences (§5.11, CLAUDE.md §27).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- A notification is a *fact addressed to a person*, distinct from the email
-- that may carry it. One fact, up to three deliveries: in-app, email, realtime.
-- Modelling it as "an email we also stored" is what produces duplicates and
-- makes an unread badge impossible.

CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience   text NOT NULL CHECK (audience IN ('customer','staff')),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  -- The duplicate defence, at the storage layer: a redelivered event produces
  -- one notification, not two (§8.3).
  dedupe_key text UNIQUE,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

COMMENT ON TABLE notifications IS
  'A fact addressed to a person. The email that may carry it is a separate row in email_messages.';

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type    text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app','email','realtime')),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, type, channel)
);

COMMENT ON TABLE notification_preferences IS
  'Opt-outs only. An absent row means enabled, so a new notification type works without a backfill.';
