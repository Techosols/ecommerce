/**
 * The one way a query reaches Postgres (§1.2).
 *
 * Every statement is parameterised, timed, and named. Slow statements are
 * logged with their name (§15.3), and driver errors are translated to
 * `AppError` at this boundary so callers never see a SQLSTATE.
 */
import type { QueryResultRow } from 'pg'
import { SLOW_QUERY_THRESHOLD_MS } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'
import { mapDatabaseError } from './errors.js'
import { getExecutor, type Executor } from './transaction.js'

const log = createLogger('database.query')

export interface QueryOptions {
  /** A short name used in logs and metrics, e.g. `events.claimBatch`. */
  name?: string
  /** Run against a specific executor instead of the ambient one. */
  executor?: Executor
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  options: QueryOptions = {},
): Promise<T[]> {
  const executor = options.executor ?? getExecutor()
  const startedAt = process.hrtime.bigint()

  try {
    const result = await executor.query<T>(sql, params as unknown[])
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      log.warn(
        {
          statement: options.name ?? 'anonymous',
          durationMs: Math.round(durationMs),
          rows: result.rowCount,
        },
        'slow query',
      )
    }
    return result.rows
  } catch (error) {
    log.debug({ statement: options.name ?? 'anonymous', err: error }, 'query failed')
    throw mapDatabaseError(error)
  }
}

/** Exactly one row expected; returns `undefined` when there is none. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  options: QueryOptions = {},
): Promise<T | undefined> {
  const rows = await query<T>(sql, params, options)
  return rows[0]
}

/** For INSERT/UPDATE/DELETE where only the affected count matters. */
export async function execute(
  sql: string,
  params: readonly unknown[] = [],
  options: QueryOptions = {},
): Promise<number> {
  const executor = options.executor ?? getExecutor()
  const startedAt = process.hrtime.bigint()

  try {
    const result = await executor.query(sql, params as unknown[])
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

    // Writes are timed for the same reason reads are, and their absence here
    // was a real gap: every INSERT, UPDATE and DELETE in the system — the
    // unbounded cleanup deletes and the rollup upsert among them — could never
    // appear as a slow query however long it took.
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      log.warn(
        {
          statement: options.name ?? 'anonymous',
          durationMs: Math.round(durationMs),
          rows: result.rowCount,
        },
        'slow write',
      )
    }
    return result.rowCount ?? 0
  } catch (error) {
    throw mapDatabaseError(error)
  }
}
