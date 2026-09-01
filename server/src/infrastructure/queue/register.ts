/**
 * Worker registration (§8.2).
 *
 * A handler is a plain typed function. The wrapper around it provides the four
 * things every job needs and no handler should re-implement: payload parsing,
 * a logger bound to the job, an abort signal for graceful shutdown, and
 * structured start/complete/fail logging.
 *
 * Handlers must be idempotent — pg-boss, like every queue, is at-least-once
 * (§8.3).
 */
import type { JobWithMetadata } from 'pg-boss'
import type { Logger } from 'pino'
import { createLogger } from '../logging/logger.js'
import { runWithContext } from '../logging/context.js'
import { getQueue } from './boss.js'
import { JOB_SCHEMAS, QUEUE_POLICIES, type JobPayload, type QueueName } from './queues.js'

const log = createLogger('queue.worker')

export interface JobContext {
  jobId: string
  queue: QueueName
  attempt: number
  logger: Logger
  /** Raised during shutdown so a long handler can stop cleanly (§8.5). */
  signal: AbortSignal
}

export type JobHandler<Q extends QueueName> = (
  payload: JobPayload<Q>,
  ctx: JobContext,
) => Promise<void>

const shutdown = new AbortController()

/** Called by the shutdown sequence to ask in-flight handlers to wind up. */
export function abortRunningJobs(): void {
  shutdown.abort()
}

export async function register<Q extends QueueName>(
  queue: Q,
  handler: JobHandler<Q>,
): Promise<void> {
  const policy = QUEUE_POLICIES[queue]

  await getQueue().work(
    queue,
    { batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) {
        const attempt = (job.retryCount ?? 0) + 1
        const jobLogger = log.child({ queue, jobId: job.id, attempt })
        const startedAt = Date.now()

        await runWithContext({ requestId: job.id, jobId: job.id, queue, attempt }, async () => {
          try {
            const payload = JOB_SCHEMAS[queue].parse(job.data) as JobPayload<Q>
            jobLogger.debug('job started')

            await handler(payload, {
              jobId: job.id,
              queue,
              attempt,
              logger: jobLogger,
              signal: shutdown.signal,
            })

            jobLogger.info({ durationMs: Date.now() - startedAt }, 'job completed')
          } catch (error) {
            jobLogger.error(
              { err: error, durationMs: Date.now() - startedAt, retryLimit: policy.retryLimit },
              'job failed',
            )
            // Rethrow so pg-boss records the failure and applies the retry policy.
            throw error
          }
        })
      }
    },
  )

  log.debug({ queue, retryLimit: policy.retryLimit }, 'worker registered')
}
