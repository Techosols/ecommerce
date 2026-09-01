/**
 * Health and readiness (§15.5).
 *
 * The split matters: a database blip should stop traffic being *routed* to this
 * instance, not restart the process. So liveness checks nothing but the event
 * loop, and readiness checks dependencies.
 */
import { getPoolRole, getPool, isPoolInitialised } from '../database/pool.js'
import { getAppliedCount, getStatus } from '../database/migrate/runner.js'
import { isQueueStarted } from '../queue/boss.js'
import { createLogger } from '../logging/logger.js'

const log = createLogger('health')

export interface CheckResult {
  status: 'pass' | 'fail'
  detail?: string
  durationMs?: number
}

export interface ReadinessReport {
  status: 'ready' | 'degraded'
  checks: Record<string, CheckResult>
}

async function timed(fn: () => Promise<string | undefined>): Promise<CheckResult> {
  const start = Date.now()
  try {
    const detail = await fn()
    return { status: 'pass', durationMs: Date.now() - start, ...(detail ? { detail } : {}) }
  } catch (error) {
    return {
      status: 'fail',
      durationMs: Date.now() - start,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function checkDatabase(): Promise<CheckResult> {
  return timed(async () => {
    if (!isPoolInitialised()) throw new Error('pool not initialised')
    await getPool().query('SELECT 1')
    return undefined
  })
}

/** A running process whose schema is behind the code is not ready to serve. */
export async function checkMigrations(): Promise<CheckResult> {
  return timed(async () => {
    const status = await getStatus(getPool())
    if (status.drifted.length > 0) {
      throw new Error(`migration drift: ${status.drifted.map((d) => d.name).join(', ')}`)
    }
    if (status.pending.length > 0) {
      throw new Error(`${status.pending.length} migration(s) pending`)
    }
    const applied = await getAppliedCount(getPool())
    return `${applied} applied`
  })
}

export function checkQueue(): CheckResult {
  // The API deliberately does not start pg-boss (§9 / boss.ts), so "not
  // started" is a normal state *there* rather than a failure.
  //
  // In the worker it is the opposite: a worker whose queue is not running is a
  // worker that does no work, and reporting `pass` for it would make the probe
  // useless in the one process where it means something.
  if (isQueueStarted()) return { status: 'pass' }
  return getPoolRole() === 'worker'
    ? { status: 'fail', detail: 'the queue is not running in this worker' }
    : { status: 'pass', detail: 'not started in this process' }
}

export async function readiness(): Promise<ReadinessReport> {
  const [database, migrations] = await Promise.all([checkDatabase(), checkMigrations()])
  const checks: Record<string, CheckResult> = { database, migrations, queue: checkQueue() }

  const failed = Object.entries(checks).filter(([, check]) => check.status === 'fail')
  if (failed.length > 0) {
    log.warn({ failed: failed.map(([name]) => name) }, 'readiness degraded')
  }

  return { status: failed.length === 0 ? 'ready' : 'degraded', checks }
}
