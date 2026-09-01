/**
 * Typed job enqueueing (§9.2).
 *
 * The payload is validated against the queue's schema before it is sent, so a
 * bad payload fails at the producer rather than in a worker minutes later.
 */
import { createLogger } from '../logging/logger.js'
import { getQueue } from './boss.js'
import { JOB_SCHEMAS, type JobPayload, type QueueName } from './queues.js'

const log = createLogger('queue.enqueue')

export interface EnqueueOptions {
  /** Delay before the job becomes eligible (seconds, or an absolute date). */
  startAfter?: number | Date
  /** Collapses duplicates: only one job with this key may be pending. */
  singletonKey?: string
  priority?: number
}

export async function enqueue<Q extends QueueName>(
  queue: Q,
  payload: JobPayload<Q>,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const schema = JOB_SCHEMAS[queue]
  const parsed = schema.parse(payload) as object

  const jobId = await getQueue().send(queue, parsed, {
    ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    ...(options.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
  })

  log.debug({ queue, jobId, singletonKey: options.singletonKey }, 'job enqueued')
  return jobId
}
