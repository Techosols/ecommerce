/**
 * The mail pipeline (§10.1): row first, then job, then provider — and safe to
 * run twice at every step.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { emailService } from '../../src/infrastructure/email/email.service.js'
import { setEmailProvider } from '../../src/infrastructure/email/index.js'
import { emailSendHandler } from '../../src/jobs/email/emailSend.job.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import type { EmailProvider } from '../../src/infrastructure/email/provider.js'
import type { JobContext } from '../../src/infrastructure/queue/register.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

// The queue is not started in tests, so enqueueing is stubbed: this suite is
// about the mail pipeline, not about pg-boss.
vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return { ...actual, enqueue: vi.fn(async () => 'stub-job-id') }
})

const sent: { to: string; subject: string }[] = []

const fakeProvider: EmailProvider = {
  name: 'fake',
  async send(message) {
    sent.push({ to: message.to, subject: message.subject })
    return { providerMessageId: `fake-${sent.length}` }
  },
}

function jobContext(): JobContext {
  return {
    jobId: 'job-1',
    queue: 'email.send',
    attempt: 1,
    logger: createLogger('test'),
    signal: new AbortController().signal,
  }
}

async function messageRow(id: string) {
  return queryOne<{ status: string; attempts: number; provider_message_id: string | null }>(
    'SELECT status, attempts, provider_message_id FROM email_messages WHERE id = $1',
    [id],
  )
}

describeIfDatabase('email pipeline', () => {
  beforeAll(setupDatabase)
  beforeEach(() => {
    sent.length = 0
    setEmailProvider(fakeProvider)
  })
  afterEach(async () => {
    setEmailProvider(undefined)
    await truncateAll()
  })
  afterAll(teardownDatabase)

  const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }

  it('records the message before any job exists', async () => {
    const result = await emailService.enqueue({
      to: 'Person@Example.test',
      template: 'system-check',
      props,
    })

    expect(result.status).toBe('queued')
    const row = await queryOne<{ to_email: string; subject: string; status: string }>(
      'SELECT to_email, subject, status FROM email_messages WHERE id = $1',
      [result.id],
    )
    expect(row?.to_email).toBe('person@example.test')
    expect(row?.status).toBe('queued')
    expect(row?.subject).toBe('Email delivery check — test')
  })

  it('sends once and marks the row sent', async () => {
    const { id } = await emailService.enqueue({
      to: 'a@example.test',
      template: 'system-check',
      props,
    })

    await emailSendHandler({ emailMessageId: id }, jobContext())

    expect(sent).toHaveLength(1)
    const row = await messageRow(id)
    expect(row?.status).toBe('sent')
    expect(row?.provider_message_id).toBe('fake-1')
  })

  it('is idempotent: a redelivered job does not send twice', async () => {
    const { id } = await emailService.enqueue({
      to: 'b@example.test',
      template: 'system-check',
      props,
    })

    await emailSendHandler({ emailMessageId: id }, jobContext())
    await emailSendHandler({ emailMessageId: id }, jobContext())

    expect(sent).toHaveLength(1)
  })

  it('deduplicates on dedupe_key, so a retried subscriber queues one message', async () => {
    const input = {
      to: 'c@example.test',
      template: 'system-check' as const,
      props,
      dedupeKey: 'system-check:once',
    }

    const first = await emailService.enqueue(input)
    const second = await emailService.enqueue(input)

    expect(first.status).toBe('queued')
    expect(second.status).toBe('duplicate')
    expect(second.id).toBe(first.id)
  })

  it('treats a suppressed recipient as suppressed, not as a failure', async () => {
    await execute(`INSERT INTO email_suppressions (email, reason) VALUES ($1, 'unsubscribe')`, [
      'blocked@example.test',
    ])

    const result = await emailService.enqueue({
      to: 'blocked@example.test',
      template: 'system-check',
      props,
    })

    expect(result.status).toBe('suppressed')
    await emailSendHandler({ emailMessageId: result.id }, jobContext())
    expect(sent).toHaveLength(0)
  })

  it('treats a missing row as success — the transaction that created it rolled back', async () => {
    await expect(
      emailSendHandler({ emailMessageId: '0199a0e0-0000-7000-8000-00000000dead' }, jobContext()),
    ).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('records the failure and rethrows so the queue can retry', async () => {
    setEmailProvider({
      name: 'broken',
      async send() {
        throw new Error('smtp refused')
      },
    })

    const { id } = await emailService.enqueue({
      to: 'd@example.test',
      template: 'system-check',
      props,
    })

    await expect(emailSendHandler({ emailMessageId: id }, jobContext())).rejects.toThrow(
      'smtp refused',
    )

    const row = await messageRow(id)
    expect(row?.status).toBe('queued')
    expect(row?.attempts).toBe(1)
  })

  it('fails an unknown template terminally instead of retrying forever', async () => {
    const { id } = await emailService.enqueue({
      to: 'e@example.test',
      template: 'system-check',
      props,
    })
    await execute(`UPDATE email_messages SET template = 'gone' WHERE id = $1`, [id])

    await expect(emailSendHandler({ emailMessageId: id }, jobContext())).resolves.toBeUndefined()
    expect((await messageRow(id))?.status).toBe('failed')
  })

  it('rejects props that do not match the template schema', async () => {
    await expect(
      emailService.enqueue({ to: 'f@example.test', template: 'system-check', props: {} as never }),
    ).rejects.toThrow()
  })
})
