/**
 * API process entrypoint (§1.1).
 *
 * HTTP + Socket.IO. It does not start pg-boss: the API writes domain events
 * inside the business transaction and the worker's dispatcher turns those into
 * jobs (§12.1). In development `RUN_WORKERS_IN_PROCESS=true` starts the worker
 * here too, so there is nothing extra to run.
 */
import { createServer } from 'node:http'
import { createApp } from '../app.js'
import { env } from '../config/index.js'
import { closePool, initPool } from '../infrastructure/database/pool.js'
import { createLogger } from '../infrastructure/logging/logger.js'
import {
  closeRealtime,
  deliverLocally,
  initRealtime,
  startRealtimeBridge,
  stopRealtimeBridge,
} from '../infrastructure/realtime/index.js'
import { failStartup, registerShutdown, type ShutdownStep } from './shutdown.js'

const log = createLogger('main.api')

async function bootstrap(): Promise<void> {
  initPool('api')

  const app = createApp()
  const httpServer = createServer(app)

  if (env.SOCKET_ENABLED) {
    initRealtime(httpServer)
    // Subscribers run in the worker, which owns no sockets. The bridge is how
    // what they raise reaches the browsers connected to *this* process — and
    // to every other API instance at the same time.
    await startRealtimeBridge(deliverLocally)
  }

  const steps: ShutdownStep[] = [
    // Realtime first, and this order is load-bearing.
    //
    // `httpServer.close()` waits for every connection to end, and a websocket
    // never ends on its own. Closing the HTTP server first therefore hangs
    // forever whenever a single client is connected — until the force timer
    // fires and kills in-flight checkouts mid-transaction. Disconnecting the
    // sockets first is what lets `close()` actually resolve.
    {
      name: 'realtime',
      run: async () => {
        await stopRealtimeBridge()
        closeRealtime()
      },
    },
    {
      name: 'http',
      run: () =>
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve())
          // Idle keep-alive sockets would otherwise hold the server open.
          httpServer.closeIdleConnections()
        }),
    },
  ]

  // Development convenience: one process, no second terminal (§22.1).
  if (env.RUN_WORKERS_IN_PROCESS) {
    const { startWorkers, stopWorkers } = await import('./worker.js')
    await startWorkers()
    steps.push({ name: 'workers', run: () => stopWorkers() })
  }

  steps.push({ name: 'database', run: () => closePool() })
  registerShutdown(steps)

  httpServer.listen(env.PORT, () => {
    log.info(
      {
        port: env.PORT,
        appEnv: env.APP_ENV,
        realtime: env.SOCKET_ENABLED,
        workersInProcess: env.RUN_WORKERS_IN_PROCESS,
      },
      'api listening',
    )
  })
}

// A bootstrap failure must exit non-zero, or an orchestrator set to restart on
// failure will treat a crashed start as a successful stop.
await bootstrap().catch(failStartup)
