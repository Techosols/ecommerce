/**
 * Authorization middleware (§6.6).
 *
 * Answers **may they do this?** — never who they are.
 *
 * Three layers work together, and only the first two live here:
 *   1. a router-level default deny on the admin surface
 *   2. a permission check per route
 *   3. a resource-level policy inside the service ("may they do it to *this*
 *      record"), which middleware cannot express because it has not loaded the
 *      record yet
 *
 * Hiding a button in React is not one of the layers (CLAUDE.md §11).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { STAFF_ROLE_KEYS } from '../auth/actor.js'
import { AuthenticationError, AuthorizationError, ERROR_CODES } from '../errors/index.js'

const log = createLogger('http.authorize')

function actorOrThrow(req: Request) {
  if (!req.actor) {
    // Reaching an authorisation check without an actor means the route is
    // missing `authenticate()`. Fail closed and make the mistake visible.
    log.error({ path: req.originalUrl }, 'authorize ran without an authenticated actor')
    throw new AuthenticationError('An access token is required', {
      code: ERROR_CODES.UNAUTHENTICATED,
    })
  }
  return req.actor
}

/** Requires one specific permission, e.g. `orders:refund`. */
export function requirePermission(permission: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const actor = actorOrThrow(req)
      if (!actor.can(permission)) {
        log.warn({ userId: actor.userId, permission, path: req.originalUrl }, 'permission denied')
        throw new AuthorizationError('You do not have permission to perform this action', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Requires every listed permission. */
export function requireAllPermissions(...permissions: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const actor = actorOrThrow(req)
      const missing = permissions.filter((permission) => !actor.can(permission))
      if (missing.length > 0) {
        log.warn({ userId: actor.userId, missing, path: req.originalUrl }, 'permission denied')
        throw new AuthorizationError('You do not have permission to perform this action', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Requires at least one of the listed roles. */
export function requireAnyRole(...roles: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const actor = actorOrThrow(req)
      if (!roles.some((role) => actor.hasRole(role))) {
        log.warn(
          { userId: actor.userId, required: roles, held: actor.roles, path: req.originalUrl },
          'role requirement not met',
        )
        throw new AuthorizationError('You do not have access to this area', {
          code: ERROR_CODES.FORBIDDEN,
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** The admin surface's default deny: staff, admin or owner (§6.6 layer 1). */
export function requireStaff(): RequestHandler {
  return requireAnyRole(...STAFF_ROLE_KEYS)
}

/**
 * Requires a verified email address.
 *
 * Not applied anywhere yet — login deliberately works before verification so
 * the store is usable — but it exists so a future feature that needs it (a
 * refund request, say) has one obvious way to say so.
 */
export function requireVerifiedEmail(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const actor = actorOrThrow(req)
      if (!actor.emailVerified) {
        throw new AuthorizationError('Please verify your email address first', {
          code: ERROR_CODES.EMAIL_NOT_VERIFIED,
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}
