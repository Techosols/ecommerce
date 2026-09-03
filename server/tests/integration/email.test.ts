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
import { withTransaction } from '../../src/infrastructure/database/transaction.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

// The queue is not started in tests, so the *send* is stubbed — but the real
// `enqueue` is kept, because whether it defers until commit is exactly what
// some of these tests are about.
const sends: string[] = []
vi.mock('../../src/infrastructure/queue/boss.js', () => ({
  getQueue: () => ({
    send: async (queue: string) => {
      sends.push(queue)
      return 'stub-job-id'
    },
  }),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
  isQueueStarted: () => true,
}))

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

  it('retries a missing row rather than assuming it was rolled back', async () => {
    /**
     * This used to resolve, on the reasoning that a missing row meant the
     * transaction that wrote it had rolled back. That reasoning was wrong in
     * the case that mattered: far more often the row exists and is simply **not
     * committed yet**, and swallowing the job destroyed the message — the job
     * was consumed, the row landed a moment later at zero attempts, and nothing
     * ever came back for it.
     *
     * Retrying costs a dead-lettered job in the genuinely-rolled-back case,
     * which is visible and harmless. The other way costs somebody's order
     * confirmation, silently.
     */
    await expect(
      emailSendHandler({ emailMessageId: '0199a0e0-0000-7000-8000-00000000dead' }, jobContext()),
    ).rejects.toThrow(/does not exist yet/)
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

  /**
   * The regression these two guard.
   *
   * The claim moves a row to `sending`, and only this handler can move it out:
   * the claim itself requires `queued`, and so does the dead-letter watcher.
   * Anything that threw between the claim and the old `try` therefore left a
   * message that no retry could take and no failure path could record — no
   * error, no status change, nothing to look at.
   *
   * It reads, from the outside, as one template quietly disappearing while
   * every other one sends: a customer's order confirmation that never arrives
   * while the staff copy of the same order does.
   */
  it('records a render failure instead of stranding the message in sending', async () => {
    const { id } = await emailService.enqueue({
      to: 'g@example.test',
      template: 'system-check',
      props,
    })

    // A template that exists in the registry but whose props the renderer will
    // reject — a failure *before* the provider is ever reached, which is the
    // half that used to vanish.
    await execute(`UPDATE email_messages SET payload = '{}'::jsonb WHERE id = $1`, [id])

    await expect(emailSendHandler({ emailMessageId: id }, jobContext())).rejects.toThrow()

    const row = await messageRow(id)
    expect(row?.status).toBe('queued')
    expect(sent).toHaveLength(0)
    const failed = await queryOne<{ last_error: string | null }>(
      'SELECT last_error FROM email_messages WHERE id = $1',
      [id],
    )
    expect(failed?.last_error).toBeTruthy()
  })

  it('does not reopen a row the provider already accepted', async () => {
    // The one throw that can reach the catch with the row already `sent` is the
    // `markSent` update itself failing. Reopening it would send a second copy
    // of somebody's order confirmation to chase a database blip.
    const { id } = await emailService.enqueue({
      to: 'h@example.test',
      template: 'system-check',
      props,
    })

    await emailSendHandler({ emailMessageId: id }, jobContext())
    expect((await messageRow(id))?.status).toBe('sent')

    // A second delivery of the same job finds nothing to claim and leaves the
    // row alone.
    await emailSendHandler({ emailMessageId: id }, jobContext())
    expect((await messageRow(id))?.status).toBe('sent')
    expect(sent).toHaveLength(1)
  })

  /**
   * The race that lost a shop its order confirmations.
   *
   * pg-boss writes on its own connection, outside whatever transaction the
   * caller is in. A job sent from inside one is therefore visible to workers
   * immediately, while the row it names is invisible to everybody until COMMIT.
   * A worker winning that race found no row, could not tell that from a
   * rolled-back transaction, reported success — and the job was gone before the
   * row existed. The row then committed at zero attempts and nothing ever came
   * back for it.
   *
   * Milliseconds wide against a local database; far wider against a managed one
   * over a network, which is why it hides in development.
   */
  it('does not queue a job until the transaction that wrote the row commits', async () => {
    sends.length = 0
    let sentDuringTransaction = 0

    await withTransaction(async () => {
      await emailService.enqueue({ to: 'race@example.test', template: 'system-check', props })
      // The row is written but not visible to anybody else yet, so no worker
      // may be told about it.
      sentDuringTransaction = sends.length
    })

    expect(sentDuringTransaction).toBe(0)
    expect(sends).toEqual(['email.send'])
  })

  it('queues nothing at all when the transaction rolls back', async () => {
    sends.length = 0

    await expect(
      withTransaction(async () => {
        await emailService.enqueue({ to: 'gone@example.test', template: 'system-check', props })
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow('changed my mind')

    // No row, so no job: the old behaviour queued one and left a worker to
    // discover the emptiness.
    expect(sends).toEqual([])
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM email_messages WHERE to_email = 'gone@example.test'`,
    )
    expect(row).toBeUndefined()
  })

  it('sends immediately when there is no transaction to wait for', async () => {
    sends.length = 0
    await emailService.enqueue({ to: 'direct@example.test', template: 'system-check', props })
    expect(sends).toEqual(['email.send'])
  })

  it('rejects props that do not match the template schema', async () => {
    await expect(
      emailService.enqueue({ to: 'f@example.test', template: 'system-check', props: {} as never }),
    ).rejects.toThrow()
  })
})
