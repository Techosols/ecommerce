/**
 * Authentication business logic (§6).
 *
 * Design decisions worth knowing before reading:
 *
 *  • **Registration never reveals whether an email exists.** It always answers
 *    202 with the same body. A new address gets a verification email; an
 *    existing one gets a "someone tried to register with your address" email.
 *    Either way the response is identical, so registration is not an
 *    enumeration oracle.
 *
 *  • **Login returns one error for everything.** Unknown email, wrong password,
 *    disabled account and locked account all produce INVALID_CREDENTIALS, and
 *    an unknown email still burns argon2 CPU, so timing does not leak either.
 *
 *  • **Emails carrying a one-time secret are enqueued directly after commit,
 *    not through the outbox.** The raw token must never be written to
 *    `domain_events`, which is a durable, queryable log. The *event* still
 *    fires — it carries the token id, never the token — so audit, analytics and
 *    security monitoring all still see the action.
 *
 *  • **Refresh rotation is a compare-and-swap.** Presenting a token that was
 *    already rotated is treated as theft and revokes the whole family.
 */
import { v7 as uuidv7 } from 'uuid'
import { env } from '../../config/index.js'
import { publish } from '../../events/index.js'
import { emailService } from '../../infrastructure/email/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import {
  accessTokenLifetimeSeconds,
  signAccessToken,
  verifyAccessToken,
} from '../../shared/auth/tokens.js'
import { generateSecret, hashSecret } from '../../shared/auth/secrets.js'
import {
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  verifyDummy,
  verifyPassword,
} from '../../shared/auth/password.js'
import {
  AuthenticationError,
  DomainRuleError,
  ERROR_CODES,
  GoneError,
  NotFoundError,
} from '../../shared/errors/index.js'
import { usersService, type User } from '../users/index.js'
import { authRepository } from './auth.repository.js'
import type {
  AuthTokenPurpose,
  IssuedTokens,
  RequestContextInput,
  SessionRecord,
  SessionRevokeReason,
} from './auth.types.js'

const log = createLogger('auth.service')

const MS_PER_DAY = 24 * 60 * 60 * 1000

function refreshExpiry(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * MS_PER_DAY)
}

/**
 * What a refresh attempt decided. Returned from the transaction so the failure
 * can be raised *after* the commit — see `refresh`.
 */
type RefreshOutcome =
  | { kind: 'rotated'; tokens: IssuedTokens; userId: string }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'inactive' }
  | { kind: 'reuse'; userId: string; familyId: string; sessionsRevoked: number }

function invalidCredentials(): AuthenticationError {
  return new AuthenticationError('Email or password is incorrect', {
    code: ERROR_CODES.INVALID_CREDENTIALS,
  })
}

function verificationLink(token: string): string {
  return `${env.CLIENT_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`
}

function resetLink(token: string): string {
  return `${env.CLIENT_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`
}

/** Issues an access token plus a fresh refresh session. */
async function issueSession(input: {
  userId: string
  roles: string[]
  familyId: string
  parentId?: string | null
  context: RequestContextInput
}): Promise<IssuedTokens> {
  const refreshToken = generateSecret()
  const session = await authRepository.createSession({
    userId: input.userId,
    familyId: input.familyId,
    tokenHash: hashSecret(refreshToken),
    parentId: input.parentId ?? null,
    userAgent: input.context.userAgent ?? null,
    ip: input.context.ip ?? null,
    expiresAt: refreshExpiry(),
  })

  const accessToken = signAccessToken({
    userId: input.userId,
    sessionId: session.id,
    roles: input.roles,
  })

  return {
    accessToken,
    expiresIn: accessTokenLifetimeSeconds(accessToken),
    refreshToken,
    refreshExpiresAt: session.expiresAt,
    sessionId: session.id,
  }
}

export const authService = {
  // ── Registration and verification ─────────────────────────────────────────

  /**
   * Always succeeds from the caller's point of view. Returns nothing the client
   * could use to tell a new address from an existing one.
   */
  async register(input: {
    email: string
    password: string
    firstName?: string
    lastName?: string
    context: RequestContextInput
  }): Promise<void> {
    assertPasswordAcceptable(input.password, input.email)

    const existing = await usersService.getByEmail(input.email)

    if (existing) {
      // Tell the account holder, not the requester. If someone is probing for
      // registered addresses, this is the only observable difference — and it
      // is observable only to the person who owns the address.
      log.info({ email: maskEmail(input.email) }, 'registration attempted for an existing account')
      await emailService.enqueue({
        to: input.email,
        template: 'account-exists',
        props: { email: input.email, resetUrl: `${env.CLIENT_ORIGIN}/forgot-password` },
        dedupeKey: `account-exists:${existing.id}:${dayStamp()}`,
      })
      return
    }

    const passwordHash = await hashPassword(input.password)

    // The identity, its roles and the event commit together or not at all.
    // `usersService.create` opens its own transaction, which nests here as a
    // savepoint rather than a second connection (§18.1).
    const user = await withTransaction(async () => {
      const created = await usersService.create({
        email: input.email,
        passwordHash,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        roles: ['customer'],
      })
      await publish(
        'customer.registered',
        { userId: created.id, email: created.email },
        { aggregateId: created.id },
      )
      return created
    })

    // After commit, never inside it: the mail carries a one-time secret and
    // must not exist for a registration that rolled back (§18.2 rule 1).
    await this.sendVerificationEmail(user.id, user.email)
    log.info({ userId: user.id }, 'customer registered')
  },

  /**
   * Issues a verification token and mails it. The raw token is passed straight
   * to the mailer and never stored anywhere but the message itself.
   */
  async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = generateSecret()
    const tokenId = await authRepository.createAuthToken({
      userId,
      purpose: 'email_verify',
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + env.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
    })

    await emailService.enqueue({
      to: email,
      template: 'email-verification',
      props: {
        verificationUrl: verificationLink(token),
        expiresInHours: env.EMAIL_VERIFICATION_TTL_HOURS,
      },
      dedupeKey: `email-verify:${tokenId}`,
    })
  },

  /** Idempotent by construction: the token is consumed with a CAS. */
  async verifyEmail(token: string): Promise<{ userId: string }> {
    const consumed = await authRepository.consumeAuthToken(hashSecret(token), 'email_verify')
    if (!consumed) {
      throw new GoneError('This verification link is invalid or has expired', {
        code: ERROR_CODES.LINK_EXPIRED,
      })
    }

    const changed = await usersService.markEmailVerified(consumed.userId)
    if (changed) {
      const user = await usersService.getById(consumed.userId)
      await publish(
        'customer.email_verified',
        { userId: consumed.userId, email: user?.email ?? '' },
        { aggregateId: consumed.userId },
      )
      log.info({ userId: consumed.userId }, 'email verified')
    }
    return { userId: consumed.userId }
  },

  /** Deliberately generic: a request for an unknown address looks identical. */
  async resendVerification(email: string): Promise<void> {
    const user = await usersService.getByEmail(email)
    if (!user || user.emailVerified || user.status !== 'active') return
    await this.sendVerificationEmail(user.id, user.email)
  },

  // ── Login and sessions ────────────────────────────────────────────────────

  async login(input: {
    email: string
    password: string
    context: RequestContextInput
  }): Promise<{ tokens: IssuedTokens; user: User }> {
    const credentials = await usersService.getCredentialsByEmail(input.email)

    // Spend comparable CPU when the account does not exist, so response time
    // does not distinguish "no such user" from "wrong password".
    if (!credentials?.passwordHash) {
      await verifyDummy()
      await authRepository.recordLoginAttempt(input.email, input.context.ip ?? null, false)
      throw invalidCredentials()
    }

    const passwordOk = await verifyPassword(credentials.passwordHash, input.password)

    if (!passwordOk) {
      await authRepository.recordLoginAttempt(input.email, input.context.ip ?? null, false)
      await this.lockIfTooManyFailures(credentials.id, input.email)
      throw invalidCredentials()
    }

    // A correct password on a disabled or locked account still answers with the
    // generic error: confirming the account exists would be the leak.
    if (credentials.status !== 'active') {
      await authRepository.recordLoginAttempt(input.email, input.context.ip ?? null, false)
      log.warn(
        { userId: credentials.id, status: credentials.status },
        'login on a non-active account',
      )
      throw invalidCredentials()
    }

    // Transparent upgrade if the cost parameters have been raised since signup.
    if (needsRehash(credentials.passwordHash)) {
      await usersService.setPasswordHash(credentials.id, await hashPassword(input.password))
    }

    const user = await usersService.getById(credentials.id)
    if (!user) throw invalidCredentials()

    const tokens = await issueSession({
      userId: user.id,
      roles: user.roles,
      familyId: uuidv7(),
      context: input.context,
    })

    await authRepository.recordLoginAttempt(input.email, input.context.ip ?? null, true)
    await usersService.recordLogin(user.id)
    await publish(
      'auth.login_succeeded',
      { userId: user.id, sessionId: tokens.sessionId, ip: input.context.ip ?? null },
      { aggregateId: user.id, actorUserId: user.id },
    )

    log.info({ userId: user.id, sessionId: tokens.sessionId }, 'login succeeded')
    return { tokens, user }
  },

  /**
   * Refresh with rotation and reuse detection (§6.3).
   *
   * The whole security property rests on one UPDATE: `markRotated` claims the
   * session only if `used_at IS NULL`. Two concurrent refreshes race on that
   * row; exactly one wins. The loser is indistinguishable from a stolen token
   * being replayed, and both are handled the same way — revoke the family.
   */
  /**
   * Refresh with rotation and reuse detection (§6.3).
   *
   * Two things make this correct under concurrency, and both are easy to get
   * subtly wrong:
   *
   *  1. **Everything runs under a per-user lock.** Without it, a loser's family
   *     revocation can scan before the winner's successor row exists, leaving a
   *     live session descended from a token just declared compromised.
   *
   *  2. **The transaction commits before the failure is raised.** Revoking a
   *     family and *then* throwing from inside the transaction would roll the
   *     revocation back — the request would fail while the stolen token stayed
   *     usable. So the transaction returns an outcome, and the throw happens
   *     after the commit.
   */
  async refresh(refreshToken: string, context: RequestContextInput): Promise<IssuedTokens> {
    const tokenHash = hashSecret(refreshToken)

    const preliminary = await authRepository.findSessionByTokenHash(tokenHash)
    if (!preliminary) {
      throw new AuthenticationError('The refresh token is not valid', {
        code: ERROR_CODES.REFRESH_TOKEN_INVALID,
      })
    }

    const outcome = await withTransaction<RefreshOutcome>(async () => {
      await authRepository.lockUserForSessionWork(preliminary.userId)

      // Re-read inside the lock: a concurrent refresh may have rotated it
      // between the preliminary lookup and here.
      const session = await authRepository.findSessionByTokenHash(tokenHash)
      if (!session) return { kind: 'unknown' }

      if (session.expiresAt <= new Date()) {
        await authRepository.revokeSession(session.id, 'expired')
        return { kind: 'expired' }
      }

      // Already used or already revoked: this token should not exist in the
      // wild. A concurrent refresh that lost the race lands here too — from the
      // server's side the two are indistinguishable, and theft is the safe
      // reading.
      if (session.usedAt !== null || session.revokedAt !== null) {
        return this.revokeCompromisedFamily(session, context)
      }

      const claimed = await authRepository.markRotated(session.id)
      if (!claimed) {
        return this.revokeCompromisedFamily(session, context)
      }

      const user = await usersService.getById(session.userId)
      if (!user || user.status !== 'active') {
        await authRepository.revokeFamily(session.familyId, 'account_disabled')
        return { kind: 'inactive' }
      }

      const tokens = await issueSession({
        userId: user.id,
        roles: user.roles,
        familyId: session.familyId,
        parentId: session.id,
        context,
      })
      return { kind: 'rotated', tokens, userId: user.id }
    })

    switch (outcome.kind) {
      case 'rotated':
        log.debug(
          { userId: outcome.userId, sessionId: outcome.tokens.sessionId },
          'refresh token rotated',
        )
        return outcome.tokens

      case 'unknown':
        throw new AuthenticationError('The refresh token is not valid', {
          code: ERROR_CODES.REFRESH_TOKEN_INVALID,
        })

      case 'expired':
        throw new AuthenticationError('The session has expired; please sign in again', {
          code: ERROR_CODES.REFRESH_TOKEN_INVALID,
        })

      case 'inactive':
        throw new AuthenticationError('This account is not active', {
          code: ERROR_CODES.ACCOUNT_DISABLED,
        })

      case 'reuse':
        log.error(
          {
            userId: outcome.userId,
            familyId: outcome.familyId,
            sessionsRevoked: outcome.sessionsRevoked,
          },
          'refresh token reuse detected — session family revoked',
        )
        throw new AuthenticationError('This session is no longer valid; please sign in again', {
          code: ERROR_CODES.SESSION_REVOKED,
        })
    }
  },

  /**
   * Ends a compromised lineage, including any successor already minted from it.
   * Revoking the honest user's live session too is deliberate: better to sign
   * them out than to leave a thief with a working session.
   */
  async revokeCompromisedFamily(
    session: SessionRecord,
    context: RequestContextInput,
  ): Promise<RefreshOutcome> {
    const revoked = await authRepository.revokeFamily(session.familyId, 'reuse_detected')

    await publish(
      'auth.token_reuse_detected',
      {
        userId: session.userId,
        familyId: session.familyId,
        sessionsRevoked: revoked,
        ip: context.ip ?? null,
      },
      { aggregateId: session.userId },
    )

    return {
      kind: 'reuse',
      userId: session.userId,
      familyId: session.familyId,
      sessionsRevoked: revoked,
    }
  },

  async logout(refreshToken: string | undefined, actorUserId?: string): Promise<void> {
    if (!refreshToken) return

    const session = await authRepository.findSessionByTokenHash(hashSecret(refreshToken))
    if (!session) return

    await authRepository.revokeSession(session.id, 'logout')
    await publish(
      'auth.logged_out',
      { userId: session.userId, sessionId: session.id, scope: 'session' },
      { aggregateId: session.userId, actorUserId: actorUserId ?? session.userId },
    )
    log.info({ userId: session.userId, sessionId: session.id }, 'logged out')
  },

  async logoutAll(userId: string): Promise<number> {
    const revoked = await authRepository.revokeAllForUser(userId, 'logout_all')
    await publish(
      'auth.logged_out',
      { userId, sessionId: null, scope: 'all', sessionsRevoked: revoked },
      { aggregateId: userId, actorUserId: userId },
    )
    log.info({ userId, revoked }, 'all sessions revoked')
    return revoked
  },

  async listSessions(userId: string): Promise<SessionRecord[]> {
    return authRepository.listActiveSessions(userId)
  },

  /** A user may only revoke their own sessions. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await authRepository.findSessionById(sessionId)
    if (!session || session.userId !== userId) {
      throw new NotFoundError('Session not found')
    }
    await authRepository.revokeSession(sessionId, 'admin_revoked')
    log.info({ userId, sessionId }, 'session revoked by its owner')
  },

  /** Used by the users feature when an account is disabled. */
  async revokeAllSessions(userId: string, reason: SessionRevokeReason): Promise<number> {
    return authRepository.revokeAllForUser(userId, reason)
  },

  // ── Passwords ─────────────────────────────────────────────────────────────

  async changePassword(input: {
    userId: string
    currentPassword: string
    newPassword: string
    keepSessionId?: string
  }): Promise<void> {
    const credentials = await usersService.getCredentialsById(input.userId)
    if (!credentials) throw new NotFoundError('User not found')

    if (!credentials.passwordHash) {
      throw new DomainRuleError(
        ERROR_CODES.PASSWORD_NOT_SET,
        'This account has no password set; use the password reset flow',
      )
    }

    const ok = await verifyPassword(credentials.passwordHash, input.currentPassword)
    if (!ok) {
      throw new AuthenticationError('The current password is incorrect', {
        code: ERROR_CODES.INVALID_CREDENTIALS,
      })
    }

    assertPasswordAcceptable(input.newPassword, credentials.email)

    const passwordHash = await hashPassword(input.newPassword)
    await withTransaction(async () => {
      await usersService.setPasswordHash(input.userId, passwordHash)
      await publish(
        'auth.password_changed',
        { userId: input.userId, method: 'change' },
        { aggregateId: input.userId, actorUserId: input.userId },
      )
    })

    // Every other session is invalidated: a password change is what a user does
    // when they think someone else has access.
    const revoked = await authRepository.revokeAllForUser(
      input.userId,
      'password_changed',
      input.keepSessionId,
    )
    log.info({ userId: input.userId, revoked }, 'password changed')
  },

  /** Always answers the same way, whether or not the address is registered. */
  async requestPasswordReset(email: string, context: RequestContextInput): Promise<void> {
    const user = await usersService.getByEmail(email)
    if (!user || user.status === 'disabled') {
      log.debug({ email: maskEmail(email) }, 'password reset requested for an unknown account')
      return
    }

    const token = generateSecret()
    const tokenId = await authRepository.createAuthToken({
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
    })

    await publish(
      'auth.password_reset_requested',
      { userId: user.id, tokenId, ip: context.ip ?? null },
      { aggregateId: user.id },
    )

    await emailService.enqueue({
      to: user.email,
      template: 'password-reset',
      props: {
        resetUrl: resetLink(token),
        expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
      },
      dedupeKey: `password-reset:${tokenId}`,
    })

    log.info({ userId: user.id }, 'password reset requested')
  },

  /**
   * Completing a reset unlocks a locked account and revokes every session —
   * the reset is the recovery path from both lockout and compromise.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Look before consuming. Validating the new password *after* burning the
    // token would mean a user who types "password" loses the only link they
    // have and must start the whole flow again — the token is spent on a
    // request that changed nothing. Single-use still rests entirely on
    // `consumeAuthToken` below, which is the atomic step.
    const tokenHash = hashSecret(token)
    const pending = await authRepository.findActiveAuthToken(tokenHash, 'password_reset')
    if (!pending) {
      throw new GoneError('This password reset link is invalid or has expired', {
        code: ERROR_CODES.LINK_EXPIRED,
      })
    }

    const user = await usersService.getById(pending.userId)
    if (!user) throw new NotFoundError('User not found')

    assertPasswordAcceptable(newPassword, user.email)
    // Hashed outside the transaction: argon2id is deliberately slow, and a
    // connection should not be held open for it.
    const passwordHash = await hashPassword(newPassword)

    await withTransaction(async () => {
      // The compare-and-swap that makes this single-use. Losing it means
      // another request consumed the token first.
      const consumed = await authRepository.consumeAuthToken(tokenHash, 'password_reset')
      if (!consumed) {
        throw new GoneError('This password reset link is invalid or has expired', {
          code: ERROR_CODES.LINK_EXPIRED,
        })
      }
      await usersService.setPasswordHash(pending.userId, passwordHash)
      if (user.status === 'locked') {
        await usersService.setStatusUnchecked(pending.userId, 'active')
      }
      await publish(
        'auth.password_changed',
        { userId: pending.userId, method: 'reset' },
        { aggregateId: pending.userId, actorUserId: pending.userId },
      )
    })

    usersService.invalidateAccess(pending.userId)
    const revoked = await authRepository.revokeAllForUser(pending.userId, 'password_reset')
    log.info({ userId: pending.userId, revoked }, 'password reset completed')
  },

  // ── Credential tokens, for features that issue their own ─────────────────
  //
  // Staff invitations need the same single-use, hashed, expiring token as a
  // password reset. Exposing the two primitives here keeps the token table and
  // its consume-with-CAS semantics owned by `auth`, rather than having a second
  // feature learn the schema.

  async createCredentialToken(input: {
    userId: string
    purpose: AuthTokenPurpose
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<string> {
    return authRepository.createAuthToken(input)
  },

  /** Single-use consumption. Throws if the token is unknown, used or expired. */
  async consumeCredentialToken(
    token: string,
    purpose: AuthTokenPurpose,
  ): Promise<{ userId: string; tokenId: string }> {
    const consumed = await authRepository.consumeAuthToken(hashSecret(token), purpose)
    if (!consumed) {
      throw new GoneError('This link is invalid or has expired', {
        code: ERROR_CODES.LINK_EXPIRED,
      })
    }
    return { userId: consumed.userId, tokenId: consumed.id }
  },

  /**
   * Redeems a credential token by setting the account's first password.
   *
   * The ordering is the same as `resetPassword`, for the same reason: the
   * password is validated before the token is consumed, so a rejected password
   * leaves the invitee's one link intact instead of stranding a staff account
   * with neither a password nor a way to set one.
   *
   * Distinct from `changePassword`, which requires the current password, and
   * from `resetPassword`, which revokes every session; a brand-new account has
   * neither a password to verify nor sessions to revoke.
   */
  async setInitialPasswordWithToken(
    token: string,
    purpose: AuthTokenPurpose,
    password: string,
  ): Promise<{ userId: string; email: string }> {
    const tokenHash = hashSecret(token)
    const pending = await authRepository.findActiveAuthToken(tokenHash, purpose)
    if (!pending) {
      throw new GoneError('This link is invalid or has expired', {
        code: ERROR_CODES.LINK_EXPIRED,
      })
    }

    const user = await usersService.getById(pending.userId)
    if (!user) throw new NotFoundError('User not found')

    assertPasswordAcceptable(password, user.email)
    const passwordHash = await hashPassword(password)

    await withTransaction(async () => {
      const consumed = await authRepository.consumeAuthToken(tokenHash, purpose)
      if (!consumed) {
        throw new GoneError('This link is invalid or has expired', {
          code: ERROR_CODES.LINK_EXPIRED,
        })
      }
      await usersService.setPasswordHash(pending.userId, passwordHash)
      await publish(
        'auth.password_changed',
        { userId: pending.userId, method: 'reset' },
        { aggregateId: pending.userId, actorUserId: pending.userId },
      )
    })

    return { userId: pending.userId, email: user.email }
  },

  // ── Maintenance, called by the cleanup.sessions job ───────────────────────

  async purgeExpiredSessions(): Promise<number> {
    return authRepository.deleteExpiredSessions()
  },

  async purgeExpiredAuthTokens(): Promise<number> {
    return authRepository.deleteExpiredAuthTokens()
  },

  async purgeOldLoginAttempts(retentionDays: number): Promise<number> {
    return authRepository.deleteOldLoginAttempts(retentionDays)
  },

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Locks an account after repeated failures, so guessing has a hard stop. */
  async lockIfTooManyFailures(userId: string, email: string): Promise<void> {
    const failures = await authRepository.countRecentFailures(
      email,
      env.LOGIN_FAILURE_WINDOW_MINUTES,
    )
    if (failures < env.LOGIN_MAX_FAILURES) return

    await usersService.setStatusUnchecked(userId, 'locked')
    usersService.invalidateAccess(userId)
    await authRepository.revokeAllForUser(userId, 'account_disabled')
    await publish('auth.account_locked', { userId, email, failures }, { aggregateId: userId })
    log.warn({ userId, failures }, 'account locked after repeated failed logins')
  },

  /** Re-exported so the socket layer and middleware share one verifier. */
  verifyAccessToken,
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

/** Coarse day bucket, so the "account exists" notice cannot be used to spam. */
function dayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}
