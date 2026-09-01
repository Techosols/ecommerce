/**
 * Idempotent unsafe requests (§19.2).
 *
 *   INSERT … ON CONFLICT DO NOTHING
 *     ├─ inserted        → run the handler, store the response
 *     └─ conflict        → completed + same body  → replay the stored response
 *                          completed + different  → 422 IDEMPOTENCY_KEY_REUSED
 *                          in progress (fresh)    → 409 REQUEST_IN_PROGRESS
 *                          in progress (stale)    → take it over
 *
 * The unique constraint provides the concurrency control, so two simultaneous
 * retries of the same key cannot both execute the handler. `request_hash`
 * prevents a client reusing a key for a different request — silently returning
 * the wrong resource would be worse than an error.
 */
import { createHash } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_STALE_LOCK_SECONDS,
  IDEMPOTENCY_TTL_HOURS,
} from '../../config/index.js'
import { execute, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { ConflictError, ERROR_CODES, ValidationError } from '../errors/index.js'

const log = createLogger('http.idempotency')

interface KeyRow {
  status: 'in_progress' | 'completed' | 'failed'
  request_hash: string
  response_status: number | null
  response_body: unknown
  locked_at: Date
}

export interface IdempotencyOptions {
  /** When false the header is optional; the default is to require it. */
  required?: boolean
}

function hashRequest(req: Request): string {
  return createHash('sha256')
    .update(JSON.stringify(req.body ?? {}), 'utf8')
    .digest('hex')
}

/**
 * Who the key belongs to.
 *
 * The authenticated user when there is one, and only then the IP. Keying a
 * signed-in caller by address is wrong in both directions:
 *
 *   • a retry whose source address changed — a phone moving from wifi to
 *     mobile data, a NAT reassignment — is a *different* actor, so the replay
 *     is not recognised and the handler runs a second time. On checkout that
 *     is two orders and two stock reservations; on a refund it is paying
 *     somebody twice.
 *   • behind a proxy every caller shares one address, so two people using the
 *     same key value collide and one gets a spurious conflict.
 *
 * A guest genuinely has no identity beyond the connection, so the address is
 * the honest fallback there — and guest checkout also carries the cart cookie,
 * which the request hash covers.
 */
function actorKey(req: Request): string {
  return req.actor?.userId ?? `ip:${req.ip ?? 'unknown'}`
}

export function idempotency(options: IdempotencyOptions = {}): RequestHandler {
  const required = options.required ?? true

  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = req.get(IDEMPOTENCY_KEY_HEADER)

    if (!key) {
      if (required) {
        next(
          new ValidationError(`The ${IDEMPOTENCY_KEY_HEADER} header is required for this request`, {
            code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
          }),
        )
        return
      }
      next()
      return
    }

    const scope = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`
    const actor = actorKey(req)
    const requestHash = hashRequest(req)

    try {
      const inserted = await execute(
        `INSERT INTO idempotency_keys (key, scope, actor_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
         ON CONFLICT (key, scope, actor_key) DO NOTHING`,
        [key, scope, actor, requestHash, IDEMPOTENCY_TTL_HOURS],
        { name: 'idempotency.claim' },
      )

      if (inserted === 0) {
        const existing = await queryOne<KeyRow>(
          `SELECT status, request_hash, response_status, response_body, locked_at
             FROM idempotency_keys
            WHERE key = $1 AND scope = $2 AND actor_key = $3`,
          [key, scope, actor],
          { name: 'idempotency.load' },
        )

        if (existing) {
          if (existing.request_hash !== requestHash) {
            next(
              new ValidationError(
                'This idempotency key was already used with a different request body',
                { code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED },
              ),
            )
            return
          }

          if (existing.status === 'completed' && existing.response_status) {
            log.debug({ key, scope }, 'replaying stored idempotent response')
            res.setHeader('Idempotent-Replay', 'true')
            res.status(existing.response_status).json(existing.response_body)
            return
          }

          const lockAgeSeconds = (Date.now() - existing.locked_at.getTime()) / 1000
          if (
            existing.status === 'in_progress' &&
            lockAgeSeconds < IDEMPOTENCY_STALE_LOCK_SECONDS
          ) {
            next(
              new ConflictError('A request with this idempotency key is still in progress', {
                code: ERROR_CODES.REQUEST_IN_PROGRESS,
                retryAfter: 2,
              }),
            )
            return
          }

          // Stale lock (the process handling it died) or a previous failure:
          // take the record over and run again.
          await execute(
            `UPDATE idempotency_keys
                SET status = 'in_progress', locked_at = now(), response_status = NULL,
                    response_body = NULL, completed_at = NULL
              WHERE key = $1 AND scope = $2 AND actor_key = $3`,
            [key, scope, actor],
            { name: 'idempotency.takeover' },
          )
          log.warn({ key, scope, lockAgeSeconds }, 'took over a stale idempotency record')
        }
      }
    } catch (error) {
      next(error)
      return
    }

    captureResponse(req, res, { key, scope, actor })
    next()
  }
}

/**
 * Records the outcome so a retry can replay it. Only 2xx responses are stored:
 * a genuine failure should be retryable.
 */
function captureResponse(
  _req: Request,
  res: Response,
  identity: { key: string; scope: string; actor: string },
): void {
  const originalJson = res.json.bind(res)

  res.json = (body: unknown) => {
    const status = res.statusCode
    const finalise =
      status >= 200 && status < 300
        ? execute(
            `UPDATE idempotency_keys
                SET status = 'completed', response_status = $4, response_body = $5,
                    completed_at = now()
              WHERE key = $1 AND scope = $2 AND actor_key = $3`,
            [identity.key, identity.scope, identity.actor, status, JSON.stringify(body)],
            { name: 'idempotency.complete' },
          )
        : execute(
            `DELETE FROM idempotency_keys WHERE key = $1 AND scope = $2 AND actor_key = $3`,
            [identity.key, identity.scope, identity.actor],
            { name: 'idempotency.release' },
          )

    finalise.catch((error: unknown) => {
      log.error({ err: error, key: identity.key }, 'failed to record idempotent response')
    })

    return originalJson(body)
  }
}
