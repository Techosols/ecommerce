/**
 * `email.send` (§10.1).
 *
 * Idempotency: the handler re-reads the row and returns immediately if it is no
 * longer `queued`. A duplicate delivery of the job therefore cannot send twice.
 * A missing row is also success — it means the transaction that created it
 * rolled back, and there is nothing to send.
 */
import { getEmailProvider } from '../../infrastructure/email/index.js'
import { settingsService } from '../../features/settings/index.js'
import { renderTemplate } from '../../infrastructure/email/renderer.js'
import { isKnownTemplate } from '../../infrastructure/email/templates/registry.js'
import { execute, queryOne } from '../../infrastructure/database/query.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

interface EmailRow {
  id: string
  to_email: string
  from_email: string
  reply_to: string | null
  template: string
  payload: Record<string, unknown>
  status: string
  attempts: number
}

// Branding comes from `store_settings`, which the settings service caches for
// 60 seconds — so this is a map lookup on all but the first send.

export async function emailSendHandler(
  payload: { emailMessageId: string },
  ctx: JobContext,
): Promise<void> {
  // ── Claim the row before sending, not after ───────────────────────────────
  //
  // Reading the status and *then* sending leaves a window in which a second
  // delivery of the same job reads `queued` too and calls the provider a second
  // time — the customer gets two copies of their order confirmation. The
  // visibility timeout makes this concrete rather than theoretical: an SMTP
  // send slower than two minutes gets a concurrent retry while the first is
  // still in flight.
  //
  // The conditional UPDATE is the claim. Exactly one worker can move the row
  // out of `queued`, and only that worker goes on to send.
  const row = await queryOne<EmailRow>(
    `UPDATE email_messages
        SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status = 'queued'
      RETURNING id, to_email, from_email, reply_to, template, payload, status, attempts`,
    [payload.emailMessageId],
    { name: 'email.claimForSend' },
  )

  if (!row) {
    // Either the row is gone, or somebody else has it. Both are "not ours".
    ctx.logger.debug(
      { emailMessageId: payload.emailMessageId },
      'email not claimable; another attempt has it or it is already handled',
    )
    return
  }

  if (!isKnownTemplate(row.template)) {
    // Unrenderable: retrying cannot help, so fail it terminally and loudly.
    await execute(
      `UPDATE email_messages SET status = 'failed', last_error = $2 WHERE id = $1`,
      [row.id, `unknown template "${row.template}"`],
      { name: 'email.markFailed' },
    )
    ctx.logger.error({ emailMessageId: row.id, template: row.template }, 'unknown email template')
    return
  }

  const branding = await settingsService.getBranding()
  const rendered = await renderTemplate(row.template, row.payload as never, branding)
  const provider = getEmailProvider()

  try {
    const result = await provider.send({
      to: row.to_email,
      from: row.from_email,
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    })

    // This row is ours — we claimed it above — so the update is unconditional
    // and the attempt count was already incremented by the claim.
    await execute(
      `UPDATE email_messages
          SET status = 'sent', provider = $2, provider_message_id = $3,
              sent_at = now(), last_error = NULL
        WHERE id = $1`,
      [row.id, provider.name, result.providerMessageId],
      { name: 'email.markSent' },
    )
    ctx.logger.info({ emailMessageId: row.id, template: row.template }, 'email sent')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Back to `queued` so the retry can claim it again; leaving it `sending`
    // would strand the message forever.
    await execute(
      `UPDATE email_messages SET status = 'queued', last_error = $2 WHERE id = $1`,
      [row.id, message],
      { name: 'email.recordFailure' },
    )
    // Rethrow so pg-boss applies the retry policy; after the last attempt the
    // dead-letter handler marks the row failed.
    throw error
  }
}
