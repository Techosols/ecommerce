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
    /**
     * Three different things look identical here, and they must not be treated
     * the same way.
     *
     *   • Another attempt of this job holds the row — genuinely not ours.
     *   • The row was already sent, suppressed or switched off — nothing to do.
     *   • **The row does not exist yet**, because the transaction that wrote it
     *     has not committed. Jobs are now deferred until after commit, so this
     *     should not happen — but a job enqueued by an older build, or by any
     *     future code that forgets, would land here.
     *
     * The third case used to be swallowed as success, which quietly destroyed
     * the message: the job was consumed, the row committed a moment later at
     * zero attempts, and nothing ever looked at it again. So a row that is not
     * there at all is a *retry*, not a completion — pg-boss backs off and tries
     * again, by which time any pending commit has landed. A row that exists but
     * is not claimable is somebody else's, and that is a real completion.
     */
    const exists = await queryOne<{ status: string }>(
      'SELECT status FROM email_messages WHERE id = $1',
      [payload.emailMessageId],
      { name: 'email.checkExists' },
    )

    if (!exists) {
      ctx.logger.warn(
        { emailMessageId: payload.emailMessageId, attempt: ctx.attempt },
        'email row not found; retrying in case its transaction has not committed',
      )
      // After the retries are spent this dead-letters, which is the right
      // outcome for a transaction that genuinely rolled back: visible, once.
      throw new Error(`Email message ${payload.emailMessageId} does not exist yet`)
    }

    ctx.logger.debug(
      { emailMessageId: payload.emailMessageId, status: exists.status },
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

  /**
   * Everything after the claim runs inside the catch, not just the send.
   *
   * The claim moves the row to `sending`, and `sending` is a state only this
   * function can leave: the claim itself requires `queued`, so a retry cannot
   * re-take the row, and the dead-letter watcher's `WHERE status = 'queued'`
   * cannot mark it failed either. Anything that throws between the claim and
   * the `catch` therefore strands the message in `sending` for good — no
   * retry, no failure, no `last_error`, nothing in the table that says a word
   * about it.
   *
   * That is not a theoretical window. `getBranding()` is a database call,
   * `renderTemplate()` reads two files off disk and compiles MJML, and
   * `getEmailProvider()` builds a transport from config. A missing template
   * file or a bad SMTP setting takes out one template and leaves every other
   * one sending normally — which reads, from the outside, as "the customer's
   * order email vanished but the staff copy arrived", with nowhere to look.
   *
   * With the work inside the try, every one of those failures does what an
   * SMTP failure already did: back to `queued`, the reason written down, and
   * the retry policy left to decide when to give up.
   */
  try {
    const branding = await settingsService.getBranding()
    const rendered = await renderTemplate(row.template, row.payload as never, branding)
    const provider = getEmailProvider()

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
    //
    // Guarded on `sending` because the only throw that can reach here with the
    // row already moved on is the `markSent` update itself failing *after* the
    // provider accepted the message. Reopening that row would send a second
    // copy of somebody's order confirmation to chase a database blip.
    await execute(
      `UPDATE email_messages
          SET status = 'queued', last_error = $2
        WHERE id = $1 AND status = 'sending'`,
      [row.id, message],
      { name: 'email.recordFailure' },
    )
    // The provider logs its own failures; a template that will not render or a
    // settings read that fell over logged nothing at all until now.
    ctx.logger.warn(
      { err: error, emailMessageId: row.id, template: row.template, to: row.to_email },
      'email send failed; requeued',
    )
    // Rethrow so pg-boss applies the retry policy; after the last attempt the
    // dead-letter handler marks the row failed.
    throw error
  }
}
