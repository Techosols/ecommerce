/**
 * Rate limiting (§16.7).
 *
 * The in-memory store is correct for a single API instance, which is the
 * deployment topology this architecture targets. If a second instance is ever
 * needed the store is swapped here and nowhere else (§9.5).
 *
 * Limits are a cost control as much as a security control.
 */
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit'
import type { Request } from 'express'
import { env } from '../../config/index.js'
import { RateLimitError } from '../errors/index.js'

export interface LimiterOptions {
  windowMs: number
  limit: number
  /** Defaults to the client IP. */
  keyBy?: (req: Request) => string
}

function createLimiter(options: LimiterOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // `false` would silently disable limiting rather than fail loudly, so the
    // switch is explicit here instead.
    skip: () => !env.RATE_LIMIT_ENABLED,
    ...(options.keyBy ? { keyGenerator: options.keyBy } : {}),
    handler: (_req, _res, next) => {
      next(
        new RateLimitError('Too many requests; please slow down', {
          retryAfter: Math.ceil(options.windowMs / 1000),
        }),
      )
    },
  })
}

/** Public reads: generous, but bounded (§16.7). */
export const storefrontLimiter = createLimiter({ windowMs: 60_000, limit: 300 })

/** Authenticated staff traffic; keyed by user once authentication exists. */
export const adminLimiter = createLimiter({ windowMs: 60_000, limit: 600 })

/** Credential endpoints. Tightened further per-route in Phase 2. */
export const authLimiter = createLimiter({ windowMs: 15 * 60_000, limit: 20 })

/** Provider callbacks: high ceiling, still bounded against a retry storm. */
export const webhookLimiter = createLimiter({ windowMs: 60_000, limit: 600 })

// ── Per-route limiters for credential endpoints (§16.7) ─────────────────────
//
// `ipKeyGenerator` normalises IPv6 to a /64 prefix, so an attacker with a huge
// v6 allocation cannot get a fresh bucket per address.

/** Keyed by client IP. */
export function ipLimiter(options: { windowMs: number; limit: number }): RateLimitRequestHandler {
  return createLimiter({
    ...options,
    keyBy: (req) => ipKeyGenerator(req.ip ?? ''),
  })
}

/**
 * Keyed by the email in the request body, so one account cannot be ground down
 * from many addresses. Falls back to IP when no email was supplied — a request
 * that failed validation still costs something.
 *
 * Runs after `express.json()` (app-level) and before `validate`, so the body is
 * parsed but not yet checked; the key is therefore treated as untrusted input
 * and truncated.
 */
export function emailKeyedLimiter(options: {
  windowMs: number
  limit: number
}): RateLimitRequestHandler {
  return createLimiter({
    ...options,
    keyBy: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email
      if (typeof email === 'string' && email.length > 0) {
        return `email:${email.trim().toLowerCase().slice(0, 254)}`
      }
      return ipKeyGenerator(req.ip ?? '')
    },
  })
}

/** Keyed by the authenticated user; only usable behind `authenticate()`. */
export function userLimiter(options: { windowMs: number; limit: number }): RateLimitRequestHandler {
  return createLimiter({
    ...options,
    keyBy: (req) => (req.actor ? `user:${req.actor.userId}` : ipKeyGenerator(req.ip ?? '')),
  })
}

export { createLimiter }
