/**
 * Security headers and CORS (§16.1, §16.2).
 *
 * The API returns JSON only, so its own CSP can be maximally restrictive —
 * there is no legitimate reason for a browser to execute anything from an API
 * response.
 *
 * CORS is an explicit allowlist of the two known frontend origins, with
 * credentials enabled because the refresh cookie needs them. There is no
 * wildcard, and a wildcard would be invalid anyway once credentials are on.
 */
import cors, { type CorsOptions } from 'cors'
import helmet from 'helmet'
import type { RequestHandler } from 'express'
import { env, isProduction } from '../../config/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'

const log = createLogger('http.security')

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  })
}

export const ALLOWED_ORIGINS: readonly string[] = [env.CLIENT_ORIGIN, env.ADMIN_ORIGIN]

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin, curl, or a server-to-server call. CORS
    // does not apply, so there is nothing to allow or deny here.
    if (!origin) {
      callback(null, true)
      return
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true)
      return
    }
    log.warn({ origin }, 'blocked cross-origin request')
    callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Requested-With'],
  exposedHeaders: ['X-Request-Id', 'Idempotent-Replay', 'Retry-After'],
  maxAge: 600,
}

export function corsMiddleware(): RequestHandler {
  return cors(corsOptions)
}

/** Provider callbacks are server-to-server; a browser must never reach them. */
export function noCors(): RequestHandler {
  return cors({ origin: false })
}
