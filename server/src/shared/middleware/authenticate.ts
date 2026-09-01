/**
 * Authentication middleware (§6.1).
 *
 * Answers exactly one question: **who is this?** It never consults roles or
 * permissions — that is `authorize`'s job, and keeping the two apart is what
 * stops authorisation logic leaking into a dozen route files.
 *
 * The token supplies identity; the database supplies standing. Reading roles
 * and status per request (through a 30-second cache) means disabling an account
 * or changing a role takes effect in seconds rather than at token expiry.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { usersService } from '../../features/users/index.js'
import { setContext } from '../../infrastructure/logging/context.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { verifyAccessToken } from '../auth/tokens.js'
import { AuthenticationError, ERROR_CODES } from '../errors/index.js'

const log = createLogger('http.authenticate')

function extractBearer(req: Request): string | undefined {
  const header = req.get('authorization')
  if (!header) return undefined
  const [scheme, token] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return undefined
  return token.trim() || undefined
}

async function attachActor(req: Request): Promise<void> {
  const token = extractBearer(req)
  if (!token) {
    throw new AuthenticationError('An access token is required', {
      code: ERROR_CODES.UNAUTHENTICATED,
    })
  }

  // Throws TOKEN_EXPIRED / TOKEN_INVALID with the algorithm and issuer pinned.
  const claims = verifyAccessToken(token)

  const actor = await usersService.resolveActor(claims.sub, claims.sid)
  if (!actor) {
    // The token verifies but the identity is gone. Never a 404: that would
    // confirm which user ids exist.
    log.warn({ userId: claims.sub }, 'valid token for a user that no longer exists')
    throw new AuthenticationError('This session is no longer valid', {
      code: ERROR_CODES.SESSION_REVOKED,
    })
  }

  if (actor.status !== 'active') {
    throw new AuthenticationError('This account is not active', {
      code: ERROR_CODES.ACCOUNT_DISABLED,
    })
  }

  req.actor = actor
  // Every subsequent log line on this request carries the user id (§15.1).
  setContext({ userId: actor.userId })
}

/** Rejects the request when there is no valid token. */
export function authenticate(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await attachActor(req)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Attaches an actor when a valid token is present and continues regardless.
 *
 * For endpoints that serve guests and customers alike — a cart, a product page
 * that shows personalised data. A *malformed* token is still rejected: silently
 * treating it as anonymous would hide client bugs.
 */
export function authenticateOptional(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!extractBearer(req)) {
      next()
      return
    }
    try {
      await attachActor(req)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Narrows `req.actor` for handlers that run behind `authenticate()`. */
export function requireActor(req: Request) {
  if (!req.actor) {
    throw new AuthenticationError('An access token is required', {
      code: ERROR_CODES.UNAUTHENTICATED,
    })
  }
  return req.actor
}
