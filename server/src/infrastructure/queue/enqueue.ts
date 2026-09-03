/**
 * Typed job enqueueing (§9.2).
 *
 * The payload is validated against the queue's schema before it is sent, so a
 * bad payload fails at the producer rather than in a worker minutes later.
 *
 * ── Jobs wait for the transaction that justifies them ────────────────────────
 *
 * pg-boss writes on its own connection, outside whatever transaction the caller
 * is in. So a job sent from inside a transaction is visible to workers
 * **immediately**, while the rows it refers to are invisible to everybody until
 * COMMIT. A worker that wins that race looks for a row that does not exist yet
 * and concludes there is nothing to do — and because that is indistinguishable
 * from a rolled-back transaction, it reports success and the job is gone. The
 * row is then committed a moment later and never sent, with no error recorded
 * anywhere.
 *
 * That is not theoretical. It is how a shop ends up with an order confirmation
 * sitting in its outbox at zero attempts while the staff alert for the same
 * order went out: every message in the batch races the same commit, and the one
 * enqueued last has the shortest way to run.
 *
 * The window is sub-millisecond against a local database and tens of
 * milliseconds against a managed one over a network, which is exactly why this
 * hides in development and bites in production.
 *
 * So: inside a transaction, the send is deferred until after it commits. Every
 * queue in the system gets that for free, rather than each caller having to
 * remember — which is the same reason the email gate lives in `enqueue` and not
 * at fifteen call sites.
 */
import { createLogger } from '../logging/logger.js'
import { getTransaction } from '../database/transaction.js'
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

  // Validated now, in the caller's stack, so a bad payload still fails where
  // the stack trace is useful — only the send itself is deferred.
  const transaction = getTransaction()
  if (transaction) {
    transaction.afterCommit(async () => {
      await send(queue, parsed, options)
    })
    // No id to return: the job does not exist yet, and inventing one would be
    // a value a caller could act on. Nothing in this codebase uses it.
    log.debug({ queue }, 'job deferred until commit')
    return null
  }

  return send(queue, parsed, options)
}

async function send(
  queue: QueueName,
  parsed: object,
  options: EnqueueOptions,
): Promise<string | null> {
  const jobId = await getQueue().send(queue, parsed, {
    ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    ...(options.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
  })

  log.debug({ queue, jobId, singletonKey: options.singletonKey }, 'job enqueued')
  return jobId
}
