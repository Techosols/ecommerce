/**
 * The only public entry point for sending mail (§10.1).
 *
 *   emailService.enqueue(...)
 *        → INSERT email_messages (status='queued')
 *        → enqueue('email.send', { emailMessageId })
 *        → worker renders and calls EmailProvider.send()
 *
 * The row exists before the job, which buys four things at once: a durable
 * outbox for mail, a permanent record of what was sent to whom, natural
 * deduplication via `dedupe_key`, and an admin view of failures. Retrying a
 * failed send re-enqueues an existing row rather than reconstructing it.
 *
 * No controller ever calls a provider.
 */
import { v7 as uuidv7 } from 'uuid'
import { env } from '../../config/index.js'
import { queryOne } from '../database/query.js'
import { isInTransaction } from '../database/transaction.js'
import { createLogger } from '../logging/logger.js'
import { QUEUES, enqueue } from '../queue/index.js'
import { EMAIL_TEMPLATES, type TemplateName, type TemplateProps } from './templates/registry.js'

const log = createLogger('email.service')

export interface EnqueueEmailInput<T extends TemplateName> {
  to: string
  template: T
  props: TemplateProps<T>
  /**
   * Deterministic key (e.g. `order.placed:<orderId>:<userId>`). A second
   * attempt with the same key is a no-op, which is what makes a retried
   * subscriber safe (§10.1).
   */
  dedupeKey?: string
  category?: 'transactional' | 'marketing'
  replyTo?: string
}

export interface EnqueuedEmail {
  id: string
  status: 'queued' | 'suppressed' | 'duplicate'
}

async function isSuppressed(email: string): Promise<boolean> {
  const row = await queryOne<{ email: string }>(
    'SELECT email FROM email_suppressions WHERE email = $1',
    [email],
    { name: 'email.checkSuppression' },
  )
  return row !== undefined
}

export const emailService = {
  /**
   * Queues a message. Must not be called inside a business transaction: the job
   * is enqueued immediately, so a later rollback would leave a job pointing at
   * a row that never existed. Call it from an event subscriber instead — which
   * is where every feature-driven email originates (§12.3). The worker is
   * defensive about the case anyway.
   */
  async enqueue<T extends TemplateName>(input: EnqueueEmailInput<T>): Promise<EnqueuedEmail> {
    if (isInTransaction()) {
      log.warn(
        { template: input.template },
        'email enqueued inside a transaction; prefer an event subscriber (§10.1)',
      )
    }

    const definition = EMAIL_TEMPLATES[input.template]
    const props = definition.schema.parse(input.props) as TemplateProps<T>
    const subject = (definition.subject as (p: TemplateProps<T>) => string)(props)
    const to = input.to.trim().toLowerCase()

    if (await isSuppressed(to)) {
      log.info({ to, template: input.template }, 'recipient suppressed; not sending')
      const row = await insertMessage({ ...input, to, subject, props, status: 'suppressed' })
      return { id: row.id, status: 'suppressed' }
    }

    const row = await insertMessage({ ...input, to, subject, props, status: 'queued' })
    if (row.duplicate) {
      log.debug({ dedupeKey: input.dedupeKey }, 'email already queued for this dedupe key')
      return { id: row.id, status: 'duplicate' }
    }

    await enqueue(QUEUES.EMAIL_SEND, { emailMessageId: row.id })
    log.debug({ emailMessageId: row.id, template: input.template }, 'email queued')
    return { id: row.id, status: 'queued' }
  },
}

async function insertMessage(input: {
  to: string
  template: string
  subject: string
  props: unknown
  status: 'queued' | 'suppressed'
  dedupeKey?: string
  category?: 'transactional' | 'marketing'
  replyTo?: string
}): Promise<{ id: string; duplicate: boolean }> {
  const id = uuidv7()

  // ON CONFLICT makes the dedupe key do the work: a retry returns the existing
  // row instead of creating a second message.
  const row = await queryOne<{ id: string; inserted: boolean }>(
    `INSERT INTO email_messages
       (id, to_email, from_email, reply_to, template, subject, payload, category, status, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = email_messages.dedupe_key
     RETURNING id, (xmax = 0) AS inserted`,
    [
      id,
      input.to,
      env.EMAIL_FROM,
      input.replyTo ?? env.EMAIL_REPLY_TO ?? null,
      input.template,
      input.subject,
      JSON.stringify(input.props ?? {}),
      input.category ?? 'transactional',
      input.status,
      input.dedupeKey ?? null,
    ],
    { name: 'email.insertMessage' },
  )

  if (!row) throw new Error('Failed to record the email message')
  return { id: row.id, duplicate: !row.inserted }
}
