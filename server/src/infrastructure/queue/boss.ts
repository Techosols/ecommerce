/**
 * pg-boss lifecycle (§9).
 *
 * The queue lives in the same PostgreSQL as the business data, which is what
 * lets the outbox and the jobs it produces share one story (§9.1).
 *
 * Two things worth knowing:
 *  • pg-boss always connects on DATABASE_DIRECT_URL. It uses session-level
 *    advisory locks for maintenance and schema installation, which a
 *    transaction-mode pooler cannot provide (§4.2).
 *  • Only the worker process starts pg-boss. The API never enqueues directly:
 *    it writes a domain event inside the business transaction and the
 *    dispatcher turns that into jobs (§12.1). If an API route ever needs to
 *    enqueue, start a sender-mode instance here (`supervise: false,
 *    schedule: false`) rather than giving the API a full worker.
 */
import { PgBoss } from 'pg-boss'
import { env } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'
import { QUEUES, QUEUE_POLICIES, deadLetterName, type QueueName } from './queues.js'

const log = createLogger('queue.boss')

let boss: PgBoss | undefined

export interface StartQueueOptions {
  /** false → sender only: no polling, no scheduling, no maintenance. */
  supervise?: boolean
  schedule?: boolean
}

export async function startQueue(options: StartQueueOptions = {}): Promise<PgBoss> {
  if (boss) return boss

  const instance = new PgBoss({
    connectionString: env.DATABASE_DIRECT_URL,
    schema: env.QUEUE_SCHEMA,
    max: 4,
    supervise: options.supervise ?? true,
    schedule: options.schedule ?? true,
    migrate: true,
    ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  })

  instance.on('error', (error: unknown) => log.error({ err: error }, 'pg-boss error'))

  await instance.start()
  boss = instance

  await createQueues(instance)

  log.info({ schema: env.QUEUE_SCHEMA, supervise: options.supervise ?? true }, 'queue started')
  return instance
}

/**
 * pg-boss v10+ requires queues to exist before jobs are sent to them.
 * Every queue gets a dead-letter partner so a terminal failure is inspectable
 * rather than lost (§8.3).
 */
async function createQueues(instance: PgBoss): Promise<void> {
  for (const queue of Object.values(QUEUES) as QueueName[]) {
    const policy = QUEUE_POLICIES[queue]
    const dlq = deadLetterName(queue)

    await instance.createQueue(dlq, {
      retryLimit: 0,
      retentionSeconds: 60 * 60 * 24 * 30,
    })

    await instance.createQueue(queue, {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelay,
      retryBackoff: policy.retryBackoff,
      expireInSeconds: policy.expireInSeconds,
      retentionSeconds: 60 * 60 * 24 * 7,
      deadLetter: dlq,
    })
  }
}

export function getQueue(): PgBoss {
  if (!boss) {
    throw new Error('Queue has not been started. Call startQueue() at startup.')
  }
  return boss
}

export function isQueueStarted(): boolean {
  return boss !== undefined
}

export async function stopQueue(): Promise<void> {
  if (!boss) return
  const stopping = boss
  boss = undefined
  await stopping.stop({ graceful: true, close: true, timeout: 20_000 })
  log.info('queue stopped')
}
