/**
 * Staff invitations (§23.2).
 *
 * How a staff account comes into existence. The owner creates the identity with
 * no password; the invitee sets one from a single-use link. That ordering
 * matters: nobody — not even the owner — ever knows another person's password,
 * and there is no "temporary password" to be reused or shared.
 *
 * The invitation reuses the credential-token machinery from `auth` with its own
 * purpose and a longer lifetime, because an invitation is expected to sit in an
 * inbox for days whereas a password reset should not.
 *
 * As with reset tokens, the raw token goes straight to the mailer and never
 * into `domain_events` — the event carries the token *id* (§12.2).
 */
import { env } from '../../config/index.js'
import { publish } from '../../events/index.js'
import { emailService } from '../../infrastructure/email/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { generateSecret, hashSecret } from '../../shared/auth/secrets.js'
import type { Actor } from '../../shared/auth/actor.js'
import { ConflictError, DomainRuleError, ERROR_CODES, NotFoundError } from '../../shared/errors/index.js'
import { authService } from '../auth/index.js'
import { auditService } from '../audit/index.js'
import { settingsService } from '../settings/index.js'
import { usersRepository } from './users.repository.js'
import { usersService } from './users.service.js'
import type { User } from './users.types.js'

const log = createLogger('users.invitations')

const STAFF_ROLES = ['staff', 'admin', 'owner'] as const

function invitationLink(token: string): string {
  return `${env.ADMIN_ORIGIN}/accept-invitation?token=${encodeURIComponent(token)}`
}

async function issueInvitationToken(userId: string): Promise<{ token: string; tokenId: string }> {
  const token = generateSecret()
  const tokenId = await authService.createCredentialToken({
    userId,
    purpose: 'staff_invite',
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + env.STAFF_INVITATION_TTL_HOURS * 60 * 60 * 1000),
  })
  return { token, tokenId }
}

async function sendInvitationEmail(input: {
  user: User
  token: string
  tokenId: string
  invitedByName: string
}): Promise<void> {
  const settings = await settingsService.get()

  await emailService.enqueue({
    to: input.user.email,
    template: 'staff-invitation',
    props: {
      storeName: settings.storeName,
      invitedBy: input.invitedByName,
      roles: input.user.roles.join(', '),
      acceptUrl: invitationLink(input.token),
      expiresInHours: env.STAFF_INVITATION_TTL_HOURS,
    },
    dedupeKey: `staff-invite:${input.tokenId}`,
  })
}

export const invitationsService = {
  /**
   * Creates a staff identity and mails an invitation.
   *
   * Unlike customer registration this is *not* enumeration-safe, and
   * deliberately so: the caller is an authenticated owner administering their
   * own staff, and telling them "that address already has an account" is the
   * useful answer rather than a leak.
   */
  async invite(
    input: { email: string; roles: string[]; firstName?: string; lastName?: string },
    actor: Actor,
    context: { ip?: string | null } = {},
  ): Promise<User> {
    const roles = [...new Set(input.roles)]

    if (roles.length === 0 || !roles.every((role) => (STAFF_ROLES as readonly string[]).includes(role))) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        `An invitation must grant at least one of: ${STAFF_ROLES.join(', ')}`,
      )
    }
    if (roles.includes('owner') && !actor.hasRole('owner')) {
      throw new DomainRuleError(
        ERROR_CODES.ROLE_ASSIGNMENT_FORBIDDEN,
        'Only an owner may invite another owner',
      )
    }

    const existing = await usersService.getByEmail(input.email)
    if (existing) {
      throw new ConflictError('An account with that email address already exists', {
        code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      })
    }

    // No password hash: the account cannot be signed into until the invitee
    // sets one, and `login` already refuses an account with no password.
    const user = await withTransaction(async () => {
      const created = await usersService.create({
        email: input.email,
        passwordHash: null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        roles,
      })
      await auditService.record({
        actor,
        action: 'staff.invited',
        resourceType: 'user',
        resourceId: created.id,
        after: { email: created.email, roles },
        ip: context.ip ?? null,
      })
      return created
    })

    const { token, tokenId } = await issueInvitationToken(user.id)

    await publish(
      'staff.invited',
      { userId: user.id, email: user.email, roles, tokenId, invitedBy: actor.userId },
      { aggregateId: user.id, actorUserId: actor.userId },
    )

    await sendInvitationEmail({
      user,
      token,
      tokenId,
      invitedByName: actor.email,
    })

    log.info({ userId: user.id, roles, invitedBy: actor.userId }, 'staff invited')
    return user
  },

  /** Issues a fresh invitation, invalidating any outstanding one. */
  async resend(userId: string, actor: Actor): Promise<void> {
    const user = await usersService.getById(userId)
    if (!user) throw new NotFoundError('User not found')

    if (!usersService.isStaff(user.roles)) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That account is not a staff account',
      )
    }
    const credentials = await usersService.getCredentialsById(userId)
    if (credentials?.passwordHash) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That invitation has already been accepted',
      )
    }

    const { token, tokenId } = await issueInvitationToken(user.id)
    await sendInvitationEmail({ user, token, tokenId, invitedByName: actor.email })

    log.info({ userId: user.id, actorId: actor.userId }, 'staff invitation resent')
  },

  /**
   * Accepts an invitation: consumes the token, sets the password, and marks the
   * address verified — clicking a link that only reached that inbox is itself
   * proof of control, so a second verification email would be theatre.
   *
   * Returns nothing. The client signs in normally, which keeps one login path.
   */
  async accept(token: string, password: string): Promise<{ userId: string }> {
    // Validates the password *before* the token is consumed, so a weak choice
    // costs a retry rather than the invitation itself.
    const { userId } = await authService.setInitialPasswordWithToken(
      token,
      'staff_invite',
      password,
    )
    const user = await usersService.getById(userId)
    if (!user) throw new NotFoundError('User not found')

    await withTransaction(async () => {
      await usersRepository.markEmailVerified(userId)
      await publish(
        'staff.invitation_accepted',
        { userId, email: user.email },
        { aggregateId: userId, actorUserId: userId },
      )
    })

    usersService.invalidateAccess(userId)
    log.info({ userId }, 'staff invitation accepted')
    return { userId }
  },
}
