/**
 * What the shop actually sent, and what became of it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `email_messages` has always recorded everything needed to answer "why did
 * nobody get that email" — the recipient, the status, how many attempts it
 * took, the provider's own error — and nothing has ever exposed it. So the
 * question could only be answered by someone with a psql prompt, which in
 * practice means it was answered by guessing.
 *
 * Every one of the states below is a different problem with a different fix,
 * and they are indistinguishable from an empty inbox:
 *
 *   sent        the provider accepted it; if it did not arrive the problem is
 *               downstream — SPF, DKIM, DMARC, or a spam folder
 *   queued      a send failed and it is waiting to be retried; `lastError` says
 *               why, and this is where SMTP auth and relay refusals appear
 *   sending     a worker claimed it and has not finished
 *   failed      it ran out of retries; `lastError` says why
 *   disabled    switched off on this page
 *   suppressed  the recipient is on the suppression list
 *
 * ── What it deliberately does not carry ──────────────────────────────────────
 *
 * Not the rendered body, and not `payload`. The props of an order email include
 * the customer's name and full delivery address, and an operations screen about
 * *delivery* has no business being a second place the shop's personal data can
 * be read from. Recipient, subject and outcome are what diagnose a delivery
 * problem.
 */
import { query, queryOne } from '../database/query.js'
import { QUEUES, enqueue } from '../queue/index.js'
import { NotFoundError, ValidationError } from '../../shared/errors/index.js'

export type EmailLogStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'suppressed' | 'disabled'

export interface EmailLogEntry {
  id: string
  to: string
  template: string
  subject: string
  status: EmailLogStatus
  attempts: number
  lastError: string | null
  provider: string | null
  sentAt: string | null
  createdAt: string
}

interface Row {
  id: string
  to_email: string
  template: string
  subject: string
  status: EmailLogStatus
  attempts: number
  last_error: string | null
  provider: string | null
  sent_at: Date | null
  created_at: Date
}

function toEntry(row: Row): EmailLogEntry {
  return {
    id: row.id,
    to: row.to_email,
    template: row.template,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    provider: row.provider,
    sentAt: row.sent_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

export const emailLogService = {
  async list(filter: {
    status?: EmailLogStatus
    to?: string
    limit: number
    offset: number
  }): Promise<{ rows: EmailLogEntry[]; total: number }> {
    const where: string[] = []
    const params: unknown[] = []

    if (filter.status) {
      params.push(filter.status)
      where.push(`status = $${params.length}`)
    }
    if (filter.to) {
      // `to_email` is citext, so this matches however the address was typed.
      params.push(`%${filter.to.trim()}%`)
      where.push(`to_email ILIKE $${params.length}`)
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const counted = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM email_messages ${clause}`,
      params,
      { name: 'emailLog.count' },
    )

    params.push(filter.limit, filter.offset)
    const rows = await query<Row>(
      `SELECT id, to_email, template, subject, status, attempts, last_error, provider,
              sent_at, created_at
         FROM email_messages
         ${clause}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
      { name: 'emailLog.list' },
    )

    return { rows: rows.map(toEntry), total: Number(counted?.count ?? 0) }
  },

  /**
   * Puts a message back in the queue.
   *
   * ── Why a failure is not always final ────────────────────────────────────
   *
   * `failed` is meant to mean "retrying cannot help": an unrenderable template,
   * a provider that refused it five times. But several of the ways a message
   * gets there are about the *shop* at that moment rather than the message —
   * an SMTP password that was wrong for an hour, a worker running a build that
   * did not yet have the template. Fix the cause and the message is perfectly
   * sendable; without this it is dead anyway, and the only recourse is asking
   * the customer to place the order again.
   *
   * `attempts` is reset, because this is a person deciding to try again after
   * changing something, not the queue grinding through its retries.
   */
  async retry(id: string): Promise<EmailLogEntry> {
    const row = await queryOne<Row>(
      `UPDATE email_messages
          SET status = 'queued', attempts = 0, last_error = NULL
        WHERE id = $1 AND status IN ('failed', 'queued', 'sending')
        RETURNING id, to_email, template, subject, status, attempts, last_error, provider,
                  sent_at, created_at`,
      [id],
      { name: 'emailLog.retry' },
    )

    if (!row) {
      // Told apart on purpose: "there is no such message" and "that one was
      // already sent" need different words, and resending a delivered message
      // is a second copy in somebody's inbox.
      const existing = await queryOne<{ status: string }>(
        'SELECT status FROM email_messages WHERE id = $1',
        [id],
        { name: 'emailLog.retryLookup' },
      )
      if (!existing) throw new NotFoundError('No such message')
      throw new ValidationError(`That message is ${existing.status} — there is nothing to retry`)
    }

    await enqueue(QUEUES.EMAIL_SEND, { emailMessageId: row.id })
    return toEntry(row)
  },

  /**
   * A count per status, for the summary above the list.
   *
   * The whole point of the screen is that "everything is fine" and "nine
   * messages are stuck" look identical until somebody counts them.
   */
  async summary(sinceHours = 24): Promise<Record<string, number>> {
    const rows = await query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM email_messages
        WHERE created_at > now() - make_interval(hours => $1)
        GROUP BY status`,
      [sinceHours],
      { name: 'emailLog.summary' },
    )

    const summary: Record<string, number> = {}
    for (const row of rows) summary[row.status] = Number(row.count)
    return summary
  },
}
