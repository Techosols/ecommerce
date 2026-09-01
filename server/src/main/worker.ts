/**
 * Worker process entrypoint (§1.1, §8.2).
 *
 * Owns pg-boss (queues, schedules, maintenance) and the outbox dispatcher.
 * Runs the same code as the API from the same image — only the command differs,
 * so the two can never drift apart.
 *
 * `startWorkers`/`stopWorkers` are exported so the API can host them in
 * development without duplicating the wiring.
 */
import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { env } from '../config/index.js'
import { registerSubscribers } from '../events/index.js'
import { startEventDispatcher, stopEventDispatcher } from '../events/dispatcher.js'
import { closePool, initPool, isPoolInitialised } from '../infrastructure/database/pool.js'
import { createLogger } from '../infrastructure/logging/logger.js'
import { abortRunningJobs, startQueue, stopQueue } from '../infrastructure/queue/index.js'
import { readiness } from '../infrastructure/observability/health.js'
import { registerAllJobs } from '../jobs/index.js'
import { failStartup, isShuttingDown, registerShutdown, type ShutdownStep } from './shutdown.js'

const log = createLogger('main.worker')

let started = false

export async function startWorkers(): Promise<void> {
  if (started) return
  started = true

  registerSubscribers()
  await startQueue()
  await registerAllJobs()
  await startEventDispatcher()

  log.info('workers started')
}

export async function stopWorkers(): Promise<void> {
  if (!started) return
  started = false

  await stopEventDispatcher()
  await stopQueue()
  log.info('workers stopped')
}

/**
 * A minimal probe surface for the worker.
 *
 * Without it the container that owns every job, the scheduler and the outbox
 * dispatcher has no liveness or readiness signal at all: pg-boss could
 * disconnect, or the dispatcher's poll loop could die, and nothing outside the
 * process would ever notice. Readiness here reports the queue honestly, so an
 * orchestrator can restart a worker that has stopped working.
 *
 * Deliberately not the API's router — no business routes, no auth, no CORS. A
 * worker that accidentally served the API would be a surprising place to find
 * a checkout endpoint.
 */
function startHealthServer(): Server {
  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.url === '/healthz') {
      return respond(200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) })
    }
    if (req.url === '/readyz') {
      if (isShuttingDown()) return respond(503, { status: 'draining' })
      return void readiness().then(
        (report) => respond(report.status === 'ready' ? 200 : 503, report),
        (error: unknown) => respond(503, { status: 'error', detail: String(error) }),
      )
    }
    return respond(404, { status: 'not_found' })
  })

  server.listen(env.WORKER_HEALTH_PORT, () => {
    log.info({ port: env.WORKER_HEALTH_PORT }, 'worker health server listening')
  })
  return server
}

async function bootstrap(): Promise<void> {
  // The worker needs session-level features (advisory locks, LISTEN), so it
  // always uses the direct connection (§4.2).
  initPool('worker')
  await startWorkers()
  const healthServer = startHealthServer()

  const steps: ShutdownStep[] = [
    { name: 'health', run: () => new Promise<void>((resolve) => healthServer.close(() => resolve())) },
    { name: 'workers', run: () => stopWorkers() },
    { name: 'database', run: () => closePool() },
  ]
  // No drain window: the worker has no load balancer in front of it, and a
  // job killed mid-flight is retried after its visibility timeout — which is
  // exactly why handlers are idempotent.
  registerShutdown(steps, { onAbort: abortRunningJobs, drainMs: 0 })
}

// Bootstrap only when this file *is* the process entrypoint. When the API
// imports it for in-process mode, the API already owns the pool and the
// shutdown sequence.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  if (isPoolInitialised()) {
    log.warn('worker entrypoint reached with an existing pool; skipping bootstrap')
  } else {
    await bootstrap().catch(failStartup)
  }
}
