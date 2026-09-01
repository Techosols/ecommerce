export type AuthTokenPurpose = 'email_verify' | 'password_reset' | 'staff_invite'

export type SessionRevokeReason =
  | 'logout'
  | 'logout_all'
  | 'rotated'
  | 'reuse_detected'
  | 'password_changed'
  | 'password_reset'
  | 'account_disabled'
  | 'admin_revoked'
  | 'expired'

export interface SessionRecord {
  id: string
  userId: string
  familyId: string
  parentId: string | null
  userAgent: string | null
  ip: string | null
  expiresAt: Date
  usedAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
  createdAt: Date
}

/** What a login or refresh hands back. The refresh token also goes in a cookie. */
export interface IssuedTokens {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresAt: Date
  sessionId: string
}

export interface RequestContextInput {
  ip?: string | null
  userAgent?: string | null
}
