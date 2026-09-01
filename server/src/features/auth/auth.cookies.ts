/**
 * Refresh-token cookie handling (§6.2).
 *
 * The refresh token lives in an httpOnly cookie scoped to the auth routes, so
 * no script can read it and it is not sent to any other endpoint. The access
 * token is never put in a cookie — it goes in the response body for the client
 * to hold in memory, which keeps it out of storage a XSS payload could read.
 *
 * CSRF: the cookie is SameSite=Strict by default, so a cross-site request
 * cannot carry it. Where the frontends cannot share a registrable domain with
 * the API, `AUTH_COOKIE_SAMESITE=none` is available and then the deployment
 * must be HTTPS (enforced in config).
 */
import type { Request, Response } from 'express'
import { API_BASE_PATH, env, isProduction } from '../../config/index.js'

export const REFRESH_COOKIE_NAME = 'refresh_token'
export const REFRESH_COOKIE_PATH = `${API_BASE_PATH}/auth`

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction || env.AUTH_COOKIE_SAMESITE === 'none',
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  })
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction || env.AUTH_COOKIE_SAMESITE === 'none',
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  })
}

/**
 * The cookie is the primary carrier. A body field is accepted as a fallback for
 * native clients, which have no cookie jar; being body-supplied it is immune to
 * CSRF rather than a weakening of it.
 */
export function readRefreshToken(req: Request): string | undefined {
  const fromCookie = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE_NAME]
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie

  const fromBody = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody

  return undefined
}
