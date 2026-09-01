/**
 * Worker registration table (§8.2).
 *
 * One place that answers "what does the worker actually do?".
 * Every queue registered here also gets a dead-letter watcher, so a job that
 * exhausts its retries raises a `job.dead_lettered` domain event rather than
 * disappearing.
 */
import type { JobWithMetadata } from 'pg-boss'
import { execute } from '../infrastructure/database/query.js'
import { createLogger } from '../infrastructure/logging/logger.js'
import {
  QUEUES,
  QUEUE_POLICIES,
  QUEUE_SCHEDULES,
  deadLetterName,
  getQueue,
  register,
  type QueueName,
} from '../infrastructure/queue/index.js'
import { publish } from '../events/index.js'
import { emailSendHandler } from './email/emailSend.job.js'
import { cleanupEventsHandler, cleanupIdempotencyHandler } from './cleanup/cleanup.jobs.js'
import { cleanupSessionsHandler } from './cleanup/sessions.job.js'
import { processImageHandler } from './media/processImage.job.js'
import { cleanupMediaHandler } from './media/cleanupMedia.job.js'
import { expireReservationsHandler } from './inventory/expireReservations.job.js'
import { abandonCartsHandler } from './carts/abandonCarts.job.js'
import { expireUnpaidOrdersHandler } from './orders/expireUnpaid.job.js'
import { analyticsRollupHandler } from './analytics/rollup.job.js'

const log = createLogger('jobs')

export async function registerAllJobs(): Promise<void> {
  await register(QUEUES.EMAIL_SEND, emailSendHandler)
  await register(QUEUES.CLEANUP_IDEMPOTENCY, cleanupIdempotencyHandler)
  await register(QUEUES.CLEANUP_EVENTS, cleanupEventsHandler)
  await register(QUEUES.CLEANUP_SESSIONS, cleanupSessionsHandler)
  await register(QUEUES.MEDIA_PROCESS_IMAGE, processImageHandler)
  await register(QUEUES.CLEANUP_MEDIA, cleanupMediaHandler)
  await register(QUEUES.INVENTORY_EXPIRE_RESERVATIONS, expireReservationsHandler)
  await register(QUEUES.CARTS_ABANDONED_SCAN, abandonCartsHandler)
  await register(QUEUES.ORDER_EXPIRE_UNPAID, expireUnpaidOrdersHandler)
  await register(QUEUES.ANALYTICS_ROLLUP, analyticsRollupHandler)

  await registerDeadLetterWatchers()
  await registerSchedules()

  log.info({ queues: Object.values(QUEUES).length }, 'job handlers registered')
}

/**
 * A dead-lettered job is a fact the business may need to react to, so it enters
 * the same event pipeline as everything else rather than being only a log line.
 */
async function registerDeadLetterWatchers(): Promise<void> {
  const boss = getQueue()

  for (const queue of Object.values(QUEUES) as QueueName[]) {
    const dlq = deadLetterName(queue)

    await boss.work(
      dlq,
      { batchSize: 10, includeMetadata: true },
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
          log.error({ queue, deadLetterJobId: job.id }, 'job dead-lettered')

          // Emails carry a row we can mark, so operators see failures in one place.
          if (queue === QUEUES.EMAIL_SEND) {
            const data = job.data as { emailMessageId?: string } | null
            if (data?.emailMessageId) {
              await execute(
                `UPDATE email_messages SET status = 'failed' WHERE id = $1 AND status = 'queued'`,
                [data.emailMessageId],
                { name: 'email.markDeadLettered' },
              )
            }
          }

          await publish('job.dead_lettered', {
            queue,
            jobId: job.id,
            attempts: QUEUE_POLICIES[queue].retryLimit + 1,
            ...(typeof job.output === 'string' ? { error: job.output } : {}),
          })
        }
      },
    )
  }
}

async function registerSchedules(): Promise<void> {
  const boss = getQueue()
  for (const schedule of QUEUE_SCHEDULES) {
    await boss.schedule(schedule.queue, schedule.cron, (schedule.data ?? {}) as object, {
      // One instance at a time even if several workers are running (§8.4).
      singletonKey: `schedule:${schedule.queue}`,
    })
    log.debug({ queue: schedule.queue, cron: schedule.cron }, 'schedule registered')
  }
}
