/**
 * Operational endpoints (§15.5). Unversioned: they describe the process, not
 * the API contract, and their consumers are probes rather than clients.
 */
import { Router } from 'express'
import { env } from '../config/index.js'
import { readiness } from '../infrastructure/observability/health.js'
import { isShuttingDown } from '../main/shutdown.js'

export const healthRouter: Router = Router()

/** Liveness: is the process running? No dependency checks, by design. */
healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) })
})

/**
 * Readiness: should the load balancer send this instance traffic?
 *
 * Answers 503 the moment shutdown begins, *before* the listener closes. That
 * ordering is the whole of a zero-downtime deploy: the balancer sees this
 * instance go unready and stops routing to it while it is still able to finish
 * what it has. Without it, every connection sent between SIGTERM and the
 * balancer noticing is refused — a burst of 502s on each release.
 */
healthRouter.get('/readyz', async (_req, res) => {
  if (isShuttingDown()) {
    return res.status(503).json({ status: 'draining' })
  }
  const report = await readiness()
  return res.status(report.status === 'ready' ? 200 : 503).json(report)
})

healthRouter.get('/version', (_req, res) => {
  res.status(200).json({
    name: 'ecommerce-server',
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    // Injected at build time by the deployment pipeline.
    commit: env.GIT_COMMIT,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  })
})
