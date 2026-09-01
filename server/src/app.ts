/**
 * Express application assembly (§7.5).
 *
 * No `listen()` here — the app is importable by tests exactly as it runs in
 * production, which is what makes the API tests meaningful.
 *
 * Middleware order is deliberate and asserted by a test:
 *   • the raw-body capture on webhooks runs before the JSON parser, because a
 *     signature is over raw bytes
 *   • rate limiting runs before route handling, so a flood costs little
 *   • validation runs per-route, after authentication, so unauthenticated
 *     noise is never validated
 */
import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'
import { pinoHttp } from 'pino-http'
import { API_BASE_PATH, JSON_BODY_LIMIT, env, isTest } from './config/index.js'
import { logger } from './infrastructure/logging/logger.js'
import { buildApiRouter } from './router.js'
import { healthRouter } from './routes/health.routes.js'
import {
  LOCAL_STORAGE_PATH,
  buildLocalStorageRouter,
  localStorageEnabled,
} from './routes/localStorage.routes.js'
import { errorHandler } from './shared/middleware/errorHandler.js'
import { notFound } from './shared/middleware/notFound.js'
import { requestContext } from './shared/middleware/requestContext.js'
import { corsMiddleware, securityHeaders } from './shared/middleware/security.js'

export function createApp(): Express {
  const app = express()

  // Exact hop count so req.ip is the real client and cannot be spoofed by an
  // X-Forwarded-For header the client sets itself (§16.1).
  app.set('trust proxy', env.TRUST_PROXY_HOPS)
  app.disable('x-powered-by')
  app.set('etag', false)

  app.use(requestContext)

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        // requestId is added by the logger's mixin from AsyncLocalStorage, so
        // customProps would only duplicate it on every line.
        autoLogging: {
          // Probes would otherwise dominate the log volume.
          ignore: (req: { url?: string }) => req.url === '/healthz' || req.url === '/readyz',
        },
      }),
    )
  }

  app.use(securityHeaders())
  app.use(corsMiddleware())

  // The refresh token travels in an httpOnly cookie scoped to /api/v1/auth
  // (§6.2). Nothing else in the system reads cookies.
  app.use(cookieParser())

  // Operational endpoints are unversioned and are mounted before the API so a
  // probe never depends on API middleware.
  app.use(healthRouter)

  // Development stand-in for a storage provider's signed URLs. Mounted before
  // the JSON parser because an upload is raw bytes, and never mounted in
  // production (config forbids the local provider there anyway).
  if (localStorageEnabled()) {
    app.use(LOCAL_STORAGE_PATH, buildLocalStorageRouter())
  }

  // Webhook routes install their own raw-body parser inside the API router, so
  // the general JSON parser must not consume the stream first.
  app.use((req, res, next) => {
    if (req.path.startsWith(`${API_BASE_PATH}/webhooks`)) {
      next()
      return
    }
    express.json({ limit: JSON_BODY_LIMIT })(req, res, next)
  })
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }))

  app.use(API_BASE_PATH, buildApiRouter())

  app.use(notFound)
  app.use(errorHandler)

  return app
}
