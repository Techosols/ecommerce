/**
 * Transaction management (§18.1).
 *
 *   await withTransaction(async (tx) => { ... })
 *
 * The active client is bound into `AsyncLocalStorage`, so `getExecutor()`
 * transparently returns the ambient transaction — repositories join it without
 * every caller threading a client through. Nesting reuses the outer transaction
 * via a savepoint rather than opening a second connection, which would be a
 * self-deadlock waiting to happen.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'
import { createLogger } from '../logging/logger.js'
import { getPool } from './pool.js'
import { isPostgresError, isRetryableDatabaseError, mapDatabaseError } from './errors.js'
import { ERROR_CODES, isAppError } from '../../shared/errors/index.js'

const log = createLogger('database.transaction')

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Executor = Pick<Pool | PoolClient, 'query'>

export interface Transaction {
  readonly client: PoolClient
  readonly depth: number
}

const storage = new AsyncLocalStorage<Transaction>()

export interface TransactionOptions {
  /**
   * Retry the whole callback on serialization failure / deadlock (§18.5).
   * Only safe when the callback performs no side effects outside the
   * transaction — which §18.2 rule 1 already requires.
   */
  retryable?: boolean
  maxRetries?: number
  /** Marks the transaction read-only; lets Postgres skip some bookkeeping. */
  readOnly?: boolean
}

const RETRY_DELAYS_MS = [25, 75, 200]

/**
 * A conflict is retryable whether it arrives as a raw driver error or as the
 * ConflictError the query boundary already mapped it to.
 */
function isRetryable(error: unknown): boolean {
  if (isRetryableDatabaseError(error)) return true
  return isAppError(error) && error.code === ERROR_CODES.CONCURRENT_MODIFICATION
}

/** The ambient transaction, if one is active. */
export function getTransaction(): Transaction | undefined {
  return storage.getStore()
}

/** The executor a repository should use: ambient transaction, else the pool. */
export function getExecutor(): Executor {
  return storage.getStore()?.client ?? getPool()
}

export function isInTransaction(): boolean {
  return storage.getStore() !== undefined
}

async function runNested<T>(parent: Transaction, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const savepoint = `sp_${parent.depth + 1}`
  const nested: Transaction = { client: parent.client, depth: parent.depth + 1 }

  await parent.client.query(`SAVEPOINT ${savepoint}`)
  try {
    const result = await storage.run(nested, () => fn(nested))
    await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (error) {
    await parent.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    throw error
  }
}

async function runOnce<T>(fn: (tx: Transaction) => Promise<T>, options: TransactionOptions) {
  const client = await getPool().connect()
  const tx: Transaction = { client, depth: 0 }

  try {
    await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    const result = await storage.run(tx, () => fn(tx))
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      log.error({ err: rollbackError }, 'rollback failed')
    }
    throw error
  } finally {
    client.release()
  }
}

export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const parent = storage.getStore()
  if (parent) return runNested(parent, fn)

  const maxRetries = options.retryable ? (options.maxRetries ?? RETRY_DELAYS_MS.length) : 0

  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(fn, options)
    } catch (error) {
      if (attempt < maxRetries && isRetryable(error)) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 200
        const jittered = delay + Math.floor(Math.random() * delay)
        log.warn({ attempt: attempt + 1, delayMs: jittered }, 'retrying transaction after conflict')
        await new Promise((resolve) => setTimeout(resolve, jittered))
        continue
      }

      // Only raw driver errors are translated here. An AppError has already
      // been mapped at the query boundary, and a business error thrown by the
      // callback must reach the caller unchanged — re-mapping either would
      // turn a meaningful 422 into an opaque 500.
      if (isAppError(error) || !isPostgresError(error)) throw error
      throw mapDatabaseError(error)
    }
  }
}
