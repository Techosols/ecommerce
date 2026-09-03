/**
 * Messages abandoned in `sending`.
 *
 * `sending` is a claim, and the claim is a one-way door: the send job can only
 * take a row that is `queued`, and the dead-letter watcher can only fail one
 * that is `queued`. A worker that dies between claiming and finishing — killed
 * mid-send, recycled during a deploy, its connection dropped — leaves a real
 * message that nothing will ever pick up, look at, or report.
 *
 * The sweep is the only thing that comes looking.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { emailService } from '../../src/infrastructure/email/email.service.js'
import { setEmailProvider } from '../../src/infrastructure/email/index.js'
import { recoverStuckEmailsHandler } from '../../src/jobs/email/recoverStuck.job.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import type { EmailProvider } from '../../src/infrastructure/email/provider.js'
import type { JobContext } from '../../src/infrastructure/queue/register.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import { describeIfDatabase, setupDatabase, truncateAll } from '../setup/database.js'

const enqueued: { emailMessageId: string }[] = []

vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return {
    ...actual,
    enqueue: vi.fn(async (_queue: string, payload: { emailMessageId: string }) => {
      enqueued.push(payload)
      return 'stub-job-id'
    }),
  }
})

const fakeProvider: EmailProvider = {
  name: 'fake',
  async send() {
    return { providerMessageId: 'fake-1' }
  },
}

function jobContext(): JobContext {
  return {
    jobId: 'job-1',
    queue: 'email.recover_stuck',
    attempt: 1,
    logger: createLogger('test'),
    signal: new AbortController().signal,
  }
}

const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }

/** A message claimed `minutesAgo` and never finished. */
async function stranded(to: string, minutesAgo: number): Promise<string> {
  const { id } = await emailService.enqueue({ to, template: 'system-check', props })
  await execute(
    `UPDATE email_messages
        SET status = 'sending', attempts = 1,
            created_at = now() - make_interval(mins => $2)
      WHERE id = $1`,
    [id, minutesAgo],
  )
  return id
}

/**
 * Runs the sweep, ignoring the enqueues that creating the fixtures produced —
 * building a stranded message goes through the real `emailService.enqueue`,
 * which queues a send job of its own.
 */
async function sweep(options: { stuckAfterMinutes: number; batchSize: number }): Promise<void> {
  enqueued.length = 0
  await recoverStuckEmailsHandler(options, jobContext())
}

async function statusOf(id: string) {
  return queryOne<{ status: string; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM email_messages WHERE id = $1',
    [id],
  )
}

describeIfDatabase('recovering emails abandoned in sending', () => {
  beforeAll(setupDatabase)
  beforeEach(async () => {
    enqueued.length = 0
    setEmailProvider(fakeProvider)
    await truncateAll()
  })

  it('requeues a message the worker left holding the claim', async () => {
    const id = await stranded('stuck@example.test', 60)

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    const row = await statusOf(id)
    expect(row?.status).toBe('queued')
    expect(enqueued).toEqual([{ emailMessageId: id }])
  })

  it('says in the row why it moved', async () => {
    // Otherwise the message reappears with no explanation of the gap between
    // when it was written and when it finally went.
    const id = await stranded('why@example.test', 60)
    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })
    expect((await statusOf(id))?.last_error).toContain('recovery sweep')
  })

  it('leaves a message that is still in flight alone', async () => {
    // A send in progress is not a stuck one. Reopening it would put a second
    // copy of the same email in somebody's inbox.
    const id = await stranded('busy@example.test', 2)

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    expect((await statusOf(id))?.status).toBe('sending')
    expect(enqueued).toHaveLength(0)
  })

  it('does not touch messages that finished', async () => {
    const { id: sentId } = await emailService.enqueue({
      to: 'done@example.test',
      template: 'system-check',
      props,
    })
    await execute(
      `UPDATE email_messages SET status = 'sent', created_at = now() - interval '2 hours' WHERE id = $1`,
      [sentId],
    )

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    expect((await statusOf(sentId))?.status).toBe('sent')
    expect(enqueued).toHaveLength(0)
  })

  it('keeps the attempt count, so a broken template still gives up', async () => {
    // One more go, not a fresh life. Zeroing this would loop a permanently
    // unrenderable message forever and never dead-letter it.
    const id = await stranded('spent@example.test', 60)
    await execute(`UPDATE email_messages SET attempts = 5 WHERE id = $1`, [id])

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    expect((await statusOf(id))?.attempts).toBe(5)
  })

  it('works through a backlog in bounded batches', async () => {
    for (let index = 0; index < 5; index += 1) {
      await stranded(`backlog${index}@example.test`, 60)
    }

    await sweep({ stuckAfterMinutes: 30, batchSize: 2 })

    expect(enqueued).toHaveLength(2)
  })

  it('rescues a message no worker ever picked up', async () => {
    /**
     * `queued` with **zero attempts** is the fingerprint: the claim increments
     * `attempts`, so a row still at zero has never been looked at. That is what
     * a job consumed before its row committed leaves behind — no error, no
     * status change, and nothing that will ever come back for it.
     */
    const { id } = await emailService.enqueue({
      to: 'never@example.test',
      template: 'system-check',
      props,
    })
    await execute(
      `UPDATE email_messages SET attempts = 0, created_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    )

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    expect(enqueued).toEqual([{ emailMessageId: id }])
    expect((await statusOf(id))?.last_error).toContain('Never picked up')
  })

  it('leaves a queued message that is genuinely waiting to be retried', async () => {
    // Attempts above zero means a worker has had it and a retry is scheduled.
    // Re-queueing that would send a second copy of the same email.
    const { id } = await emailService.enqueue({
      to: 'retrying@example.test',
      template: 'system-check',
      props,
    })
    await execute(
      `UPDATE email_messages SET attempts = 2, last_error = 'smtp timeout',
              created_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    )

    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })

    expect(enqueued).toHaveLength(0)
  })

  it('has nothing to say when nothing is stuck', async () => {
    await sweep({ stuckAfterMinutes: 30, batchSize: 100 })
    expect(enqueued).toHaveLength(0)
  })
})
