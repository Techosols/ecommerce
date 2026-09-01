/**
 * Graceful shutdown (§8.5).
 *
 * On SIGTERM: stop accepting work, let what is in flight finish inside a grace
 * window, then close resources in dependency order. Anything killed mid-flight
 * is retried by pg-boss after its visibility timeout — which is exactly why
 * handlers must be idempotent (§8.3).
 *
 * A second signal, or the hard deadline, exits immediately: a process that
 * refuses to die is worse than one that dies abruptly.
 */
import {
  SHUTDOWN_ABORT_AFTER_MS,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_FORCE_AFTER_MS,
} from '../config/index.js'
import { createLogger } from '../infrastructure/logging/logger.js'

const log = createLogger('shutdown')

export interface ShutdownStep {
  name: string
  run: () => Promise<void> | void
}

let shuttingDown = false

export interface ShutdownOptions {
  onAbort?: () => void
  /**
   * How long to keep serving after readiness starts failing.
   *
   * A load balancer notices an instance is unready on its own schedule — a few
   * seconds, typically. Closing the listener the instant SIGTERM arrives means
   * every connection it sends in that window is refused, which is a burst of
   * 502s on every single deploy. Failing readiness first and *then* waiting is
   * what turns a deploy into a drain.
   */
  drainMs?: number
}

export function registerShutdown(steps: ShutdownStep[], options: ShutdownOptions = {}): void {
  const { onAbort, drainMs = SHUTDOWN_DRAIN_MS } = options

  /**
   * Why the exit code differs by cause.
   *
   * A signal is an orderly stop and exits 0. A crash — an uncaught exception or
   * an unhandled rejection — must exit non-zero, or every orchestrator with
   * `restart: on-failure` will decline to restart the process and a deploy gate
   * reading the exit code will see a clean shutdown where there was a fault.
   */
  const run = async (signal: string, exitCode: number) => {
    if (shuttingDown) {
      log.warn({ signal }, 'second shutdown signal — exiting immediately')
      process.exit(exitCode || 1)
    }
    shuttingDown = true
    log.info({ signal }, 'shutting down')

    // Readiness now fails (it reads `isShuttingDown`), so give the load
    // balancer time to take this instance out before the listener closes.
    // Skipped on a crash: a process in an unknown state should not keep
    // serving checkout for another five seconds.
    if (exitCode === 0 && drainMs > 0) {
      log.info({ drainMs }, 'failing readiness and draining before close')
      await new Promise((resolve) => setTimeout(resolve, drainMs))
    }

    // Ask long-running work to wind up before the hard deadline arrives.
    const abortTimer = setTimeout(() => {
      log.warn('grace period elapsed — aborting in-flight work')
      onAbort?.()
    }, SHUTDOWN_ABORT_AFTER_MS)

    const forceTimer = setTimeout(() => {
      log.error('shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_FORCE_AFTER_MS)
    forceTimer.unref()

    for (const step of steps) {
      try {
        await step.run()
        log.debug({ step: step.name }, 'shutdown step complete')
      } catch (error) {
        log.error({ err: error, step: step.name }, 'shutdown step failed')
      }
    }

    clearTimeout(abortTimer)
    clearTimeout(forceTimer)
    log.info({ exitCode }, 'shutdown complete')
    process.exit(exitCode)
  }

  process.on('SIGTERM', () => void run('SIGTERM', 0))
  process.on('SIGINT', () => void run('SIGINT', 0))

  // A process in an unknown state must not keep serving checkout (§14.3), and
  // must exit non-zero so that whatever supervises it knows this was a fault.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled promise rejection')
    void run('unhandledRejection', 1)
  })
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception')
    void run('uncaughtException', 1)
  })
}

/**
 * Fails the process on a fatal startup error.
 *
 * A bootstrap that throws must exit non-zero. Letting the rejection reach the
 * generic handler above would work, but naming it here means the log says
 * "startup failed" rather than "unhandled promise rejection", which is the
 * difference between a five-second diagnosis and a twenty-minute one.
 */
export function failStartup(error: unknown): never {
  log.fatal({ err: error }, 'startup failed')
  process.exit(1)
}

export function isShuttingDown(): boolean {
  return shuttingDown
}
