/**
 * Access tokens (§6.2).
 *
 * Signing and verification live together so the two can never disagree about
 * algorithm, issuer or claim shape. The verifier pins the algorithm and checks
 * issuer and token type, which closes `alg: none` and token-type confusion by
 * construction.
 *
 * Permissions are deliberately NOT in the token. They are resolved per request
 * from the user's roles, so revoking a permission from a role bites
 * immediately rather than after the token expires — and the token stays small.
 */
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { env } from '../../config/index.js'
import { AuthenticationError, ERROR_CODES } from '../errors/index.js'

export interface AccessTokenClaims {
  /** User id. */
  sub: string
  /** Session id, so a socket can be dropped when its session is revoked. */
  sid: string
  roles: string[]
  typ: 'access'
}

const ALGORITHM = 'HS256' as const

export interface SignAccessTokenInput {
  userId: string
  sessionId: string
  roles: string[]
}

export function signAccessToken(input: SignAccessTokenInput): string {
  return jwt.sign(
    { sid: input.sessionId, roles: input.roles, typ: 'access' },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: ALGORITHM,
      subject: input.userId,
      issuer: env.JWT_ISSUER,
      expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    },
  )
}

/** Seconds until an access token expires — reported to clients so they can refresh ahead of time. */
export function accessTokenLifetimeSeconds(token: string): number {
  const decoded = jwt.decode(token)
  if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
    return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000))
  }
  return 0
}

function decodeWith(token: string, secret: string): JwtPayload | string {
  return jwt.verify(token, secret, {
    algorithms: [ALGORITHM],
    issuer: env.JWT_ISSUER,
  })
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  let payload: JwtPayload | string
  try {
    payload = decodeWith(token, env.JWT_ACCESS_SECRET)
  } catch (error) {
    // A rotation grace window: tokens signed with the previous secret still
    // verify until they expire (§21.3).
    if (env.JWT_PREVIOUS_ACCESS_SECRET) {
      try {
        payload = decodeWith(token, env.JWT_PREVIOUS_ACCESS_SECRET)
      } catch {
        throw toAuthError(error)
      }
    } else {
      throw toAuthError(error)
    }
  }

  if (typeof payload === 'string' || payload.typ !== 'access') {
    throw new AuthenticationError('The token is not an access token', {
      code: ERROR_CODES.TOKEN_INVALID,
    })
  }
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw new AuthenticationError('The token is missing required claims', {
      code: ERROR_CODES.TOKEN_INVALID,
    })
  }

  return {
    sub: payload.sub,
    sid: payload.sid,
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    typ: 'access',
  }
}

function toAuthError(error: unknown): AuthenticationError {
  if (error instanceof jwt.TokenExpiredError) {
    return new AuthenticationError('The access token has expired', {
      code: ERROR_CODES.TOKEN_EXPIRED,
    })
  }
  return new AuthenticationError('The access token is not valid', {
    code: ERROR_CODES.TOKEN_INVALID,
    cause: error,
  })
}
