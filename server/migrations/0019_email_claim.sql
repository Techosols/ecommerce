-- 0019_email_claim.sql
-- A `sending` state, so an email cannot be delivered twice (§10.1).
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a fourth state
--
-- The send job used to read the row, call the provider, and only then update
-- the status. Two deliveries of the same job — which pg-boss will produce
-- whenever a send outlives its visibility timeout — both read `queued`, and the
-- customer gets two copies of their order confirmation. Only the final UPDATE
-- was guarded, and by then the mail has gone.
--
-- The fix is to claim the row *before* sending, with a conditional UPDATE that
-- exactly one worker can win. That needs a state meaning "somebody is sending
-- this right now", distinct from both `queued` and `sent`.
--
-- A row stuck in `sending` means a worker died mid-send. That is deliberately
-- visible rather than silently retried: re-sending it risks a duplicate, and
-- the honest thing is for an operator to see it and decide.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages DROP CONSTRAINT email_messages_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed'));

-- Finds the stranded ones. Small by definition — anything here for more than a
-- few minutes is a worker that died holding a claim.
CREATE INDEX email_messages_sending_idx
  ON email_messages (created_at) WHERE status = 'sending';

COMMENT ON COLUMN email_messages.status IS
  'queued → sending → sent | failed. `sending` is a claim held by one worker; a row left in it is a crashed send that needs a person to look.';
