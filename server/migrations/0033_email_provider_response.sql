-- 0033_email_provider_response.sql
-- What the mail server actually said when it took the message.
-- Forward-only. Never edit a migration that has been applied (§4.4).
--
-- ── The failure this exists for ──────────────────────────────────────────────
--
-- "The delivery log says sent and the customer never got it."
--
-- `sent` in this system means something precise: the provider accepted the
-- message and did not refuse the recipient. For SMTP that is a `250` at the end
-- of DATA. It is a genuine, checkable fact — and it is emphatically *not* proof
-- of delivery, because everything that happens after the handover happens on
-- somebody else's machine: an asynchronous bounce, a spam folder, a silent
-- discard by an outgoing filter, a mailbox over quota.
--
-- Until now the shop kept no evidence of that handover beyond the word `sent`.
-- The server's reply — `250 OK id=1r4Xy2-0008Kt-9s` — was logged at debug and
-- thrown away, which is exactly the string a postmaster asks for when a message
-- was accepted on their server and never arrived at its destination. Without it
-- the conversation is "our software says it sent"; with it, it is a queue id
-- they can look up.
ALTER TABLE email_messages ADD COLUMN provider_response text;

COMMENT ON COLUMN email_messages.provider_response IS
  'The provider''s own words when it accepted the message — an SMTP 250 line and its queue id. Evidence of handover, not of delivery.';

COMMENT ON COLUMN email_messages.status IS
  'queued | sending | sent | failed | suppressed | disabled. "sent" means the provider accepted it and did not refuse the recipient; delivery happens after that, on somebody else''s machine.';
