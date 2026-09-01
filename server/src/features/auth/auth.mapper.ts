/**
 * Row → DTO (§2.1).
 *
 * Explicit mappers control exactly what leaves the server. A new column added
 * to `users` or `sessions` does not appear in an API response until someone
 * adds it here on purpose.
 */
import type { Actor } from '../../shared/auth/actor.js'
import type { User } from '../users/index.js'
import type { IssuedTokens, SessionRecord } from './auth.types.js'

export interface UserDto {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  emailVerified: boolean
  status: string
  roles: string[]
  createdAt: string
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    emailVerified: user.emailVerified,
    status: user.status,
    roles: user.roles,
    createdAt: user.createdAt.toISOString(),
  }
}

export interface CurrentUserDto extends UserDto {
  permissions: string[]
  isStaff: boolean
  sessionId: string
}

export function toCurrentUserDto(user: User, actor: Actor): CurrentUserDto {
  return {
    ...toUserDto(user),
    // The client uses these to decide what to *render*. The server has already
    // decided what it will *allow* — these are a convenience, never a control.
    permissions: [...actor.permissions].sort(),
    isStaff: actor.isStaff,
    sessionId: actor.sessionId,
  }
}

export interface SessionDto {
  id: string
  current: boolean
  userAgent: string | null
  ip: string | null
  createdAt: string
  expiresAt: string
}

export function toSessionDto(session: SessionRecord, currentSessionId?: string): SessionDto {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    userAgent: session.userAgent,
    ip: session.ip,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  }
}

export interface TokenDto {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: number
}

/** The refresh token is never in this DTO — it travels only in the cookie. */
export function toTokenDto(tokens: IssuedTokens): TokenDto {
  return {
    accessToken: tokens.accessToken,
    tokenType: 'Bearer',
    expiresIn: tokens.expiresIn,
  }
}
