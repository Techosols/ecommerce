-- 0031_email_controls.sql
-- Which emails the shop sends, and who on the staff hears about what.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ── Two features, one mechanism ──────────────────────────────────────────────
--
-- **Switching a mail off.** Every email in this system already passes through
-- one function, `emailService.enqueue`, so a per-template switch needs no change
-- at any of the fifteen call sites — and, more importantly, a call site somebody
-- adds next year cannot bypass it by forgetting to check.
--
-- **Telling staff about something.** An alert to the shop is not a different
-- mechanism; it is a template that happens to be addressed to staff. So it uses
-- the same table, the same switch and the same queue as a customer's order
-- confirmation. There is one way an email leaves this system, not two.
--
-- The registry in code remains the list of templates that *exist*. This table
-- only records what has been decided about them, which is why a template with no
-- row here is on: a new template ships working, and the shop turns it off if it
-- wants to, rather than shipping silent and waiting to be discovered.

CREATE TABLE email_template_settings (
  -- The registry key: 'order-placed', 'admin-order-placed'. Not a foreign key —
  -- the set lives in TypeScript, and a template removed from the code should
  -- leave a harmless orphan row rather than block a deploy.
  template     text PRIMARY KEY CHECK (template ~ '^[a-z][a-z0-9-]*$'),
  enabled      boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TRIGGER email_template_settings_set_updated_at
  BEFORE UPDATE ON email_template_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE email_template_settings IS
  'Per-template on/off. Absent row means on: a new template ships working.';

-- ── Who the shop's own alerts go to ──────────────────────────────────────────
--
-- A list rather than one address, because the real shape is "me, the warehouse,
-- and the accountant", and because a staff member leaving should be an edit in
-- Settings rather than a deploy.
--
-- Deliberately NOT `contact_email`: that address is printed in customer emails
-- and receives their replies. Alerts landing in the same inbox as "where is my
-- order" is how alerts stop being read.
ALTER TABLE store_settings ADD COLUMN admin_notification_emails text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN store_settings.admin_notification_emails IS
  'Staff addresses that receive shop alerts. Empty means nobody is told.';

-- ── A record of the ones we chose not to send ────────────────────────────────
--
-- `suppressed` already means "this recipient has asked us to stop". A mail the
-- shop switched off is a different fact and needs a different word, or the
-- suppression list stops meaning anything. Both are recorded rather than
-- silently dropped, so "why did nobody get the shipping email" is answerable
-- from the table instead of from someone's memory of a settings page.
--
-- Every existing value is repeated here, `sending` included — 0019 added that
-- one and the send job sets it. Rebuilding a CHECK from the *original*
-- migration rather than the current constraint silently drops whatever came in
-- between, which is a failure the job only meets in production.
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'disabled'));
