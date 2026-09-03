-- Why didn't that email arrive?
--
-- Run this in the Supabase SQL editor (or psql). It reads only; it changes
-- nothing. The `status` column is the answer, and each value means something
-- different:
--
--   sent       the provider accepted it. If nobody received it, the problem is
--              downstream — SPF/DKIM/DMARC on stdbeauty.com, or the recipient's
--              spam folder. Check `provider_message_id` against your mail
--              server's own log.
--   queued     a send failed and it is waiting to be retried. `last_error` says
--              why. This is where SMTP auth and relay refusals show up.
--   sending    a worker claimed it and never finished. Nothing retries this on
--              its own before the recovery sweep (`email.recover_stuck`, added
--              with this fix) — on the old code these sat here for ever with no
--              error recorded at all.
--   failed     it ran out of retries. `last_error` says why.
--   disabled   switched off in Settings → Emails.
--   suppressed the address is on the suppression list.

-- ── 1. The last two days of mail, newest first ───────────────────────────────
SELECT
  created_at,
  template,
  to_email,
  status,
  attempts,
  sent_at,
  left(coalesce(last_error, ''), 200) AS last_error
FROM email_messages
WHERE created_at > now() - interval '2 days'
ORDER BY created_at DESC;

-- ── 2. One specific order, customer copy and staff copy side by side ─────────
-- Replace the order number.
SELECT
  m.template,
  m.to_email,
  m.status,
  m.attempts,
  m.sent_at,
  left(coalesce(m.last_error, ''), 200) AS last_error
FROM email_messages m
JOIN orders o ON o.id::text = split_part(m.dedupe_key, ':', 2)
WHERE o.order_number = '#1001'
ORDER BY m.created_at;

-- ── 3. Anything stranded, which is the failure that leaves no trace ──────────
SELECT count(*) AS stuck_in_sending
FROM email_messages
WHERE status = 'sending' AND created_at < now() - interval '30 minutes';

-- ── 4. Is a template switched off? An empty result means none are ────────────
SELECT template, enabled, updated_at FROM email_template_settings WHERE NOT enabled;

-- ── 5. Who the staff alerts go to ────────────────────────────────────────────
SELECT admin_notification_emails, contact_email FROM store_settings;
