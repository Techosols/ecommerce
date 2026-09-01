/**
 * Connection pooling (§18.6).
 *
 * Two connection roles, because Supabase's transaction pooler cannot serve both
 * (§4.2):
 *   • `api`    → DATABASE_URL        (pooled; plain statements only)
 *   • `worker` → DATABASE_DIRECT_URL (session features: advisory locks, LISTEN)
 *   • `cli`    → DATABASE_DIRECT_URL (migrations)
 */
import { Pool, types, type PoolConfig } from 'pg'
import { env } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'

const log = createLogger('database.pool')

export type ConnectionRole = 'api' | 'worker' | 'cli'

// Keep numeric types honest. int8 (bigint) arrives as a string by default; we
// return a number because every bigint column we own is an identity or a count
// that stays well inside Number.MAX_SAFE_INTEGER. numeric stays a string — we
// never store money as numeric (§4.1 rule 2), so a numeric here is an aggregate
// the caller must convert deliberately.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10))

let pool: Pool | undefined
let currentRole: ConnectionRole | undefined

function buildConfig(role: ConnectionRole): PoolConfig {
  const connectionString = role === 'api' ? env.DATABASE_URL : env.DATABASE_DIRECT_URL
  const max =
    role === 'worker' ? Math.max(2, Math.floor(env.DATABASE_POOL_MAX / 2)) : env.DATABASE_POOL_MAX

  return {
    connectionString,
    max: role === 'cli' ? 2 : max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: `ecommerce-${role}`,
    // Workers and the CLI run longer statements than a request may (§18.2 rule 5).
    statement_timeout: role === 'api' ? env.DATABASE_STATEMENT_TIMEOUT_MS : 60_000,
    ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  }
}

export function initPool(role: ConnectionRole): Pool {
  if (pool) return pool

  pool = new Pool(buildConfig(role))
  currentRole = role

  pool.on('error', (error) => {
    // An idle client failed. pg removes it from the pool; we only need to know.
    log.error({ err: error }, 'idle database client error')
  })

  log.debug({ role, max: buildConfig(role).max }, 'database pool created')
  return pool
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool has not been initialised. Call initPool(role) at startup.')
  }
  return pool
}

export function getPoolRole(): ConnectionRole | undefined {
  return currentRole
}

export function isPoolInitialised(): boolean {
  return pool !== undefined
}

export async function closePool(): Promise<void> {
  if (!pool) return
  const closing = pool
  pool = undefined
  currentRole = undefined
  await closing.end()
  log.debug('database pool closed')
}
