/**
 * Identity and access business logic (§6.5, §6.6).
 *
 * Owns the `users` row, role assignment, and the resolution of an Actor from a
 * user id — which is what `authenticate` calls on every authenticated request.
 *
 * Two caches, both small and both explicitly invalidated:
 *   • the role→permission matrix (5 min): changes only by migration
 *   • a user's roles and status (30 s): so a role change or a disabled account
 *     takes effect within seconds without a database read per request
 */
import { publish } from '../../events/index.js'
import { TtlCache } from '../../infrastructure/cache/memory.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createActor, isStaffRoles, type Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { usersRepository } from './users.repository.js'
import type { CreateUserInput, Role, User, UserAccess, UserStatus } from './users.types.js'

const log = createLogger('users.service')

const PERMISSION_MATRIX_KEY = 'matrix'
const permissionMatrixCache = new TtlCache<Record<string, string[]>>({ ttlMs: 5 * 60_000 })
const accessCache = new TtlCache<UserAccess>({ ttlMs: 30_000, maxEntries: 20_000 })

async function permissionsForRoles(roles: readonly string[]): Promise<Set<string>> {
  const matrix = await permissionMatrixCache.getOrLoad(PERMISSION_MATRIX_KEY, () =>
    usersRepository.loadPermissionMatrix(),
  )
  const permissions = new Set<string>()
  for (const role of roles) {
    for (const permission of matrix[role] ?? []) permissions.add(permission)
  }
  return permissions
}

export const usersService = {
  /**
   * Builds the Actor for a verified token. Reads roles and status rather than
   * trusting the token's copy, so revoking a role or disabling an account takes
   * effect within the cache TTL instead of at token expiry.
   */
  async resolveActor(userId: string, sessionId: string): Promise<Actor | undefined> {
    const access = await accessCache
      .getOrLoad(userId, async () => {
        const loaded = await usersRepository.findAccess(userId)
        // Cache a tombstone-free miss by throwing; a deleted user is rare and a
        // cached `undefined` would be harder to reason about than one extra read.
        if (!loaded) throw new NotFoundError('USER_NOT_FOUND')
        return loaded
      })
      .catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined
        throw error
      })

    if (!access) return undefined

    return createActor({
      userId: access.userId,
      sessionId,
      email: access.email,
      status: access.status,
      roles: access.roles,
      permissions: await permissionsForRoles(access.roles),
      emailVerified: access.emailVerified,
    })
  },

  async getById(userId: string): Promise<User | undefined> {
    return usersRepository.findById(userId)
  },

  async getByEmail(email: string): Promise<User | undefined> {
    return usersRepository.findByEmail(email)
  },

  async getCredentialsByEmail(email: string) {
    return usersRepository.findCredentialsByEmail(email)
  },

  async getCredentialsById(userId: string) {
    return usersRepository.findCredentialsById(userId)
  },

  /**
   * Creates an identity with roles, in one transaction. Used by registration
   * and by the owner seed.
   */
  async create(input: CreateUserInput): Promise<User> {
    const requested = [...new Set(input.roles)]
    const known = await usersRepository.roleKeysExist(requested)
    const unknown = requested.filter((role) => !known.includes(role))
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown role(s): ${unknown.join(', ')}`)
    }

    const userId = await withTransaction(async () => {
      const id = await usersRepository.create(input)
      await usersRepository.assignRoles(id, requested, null)
      await publish(
        'user.created',
        { userId: id, email: input.email, roles: requested },
        { aggregateId: id },
      )
      return id
    })

    const created = await usersRepository.findById(userId)
    if (!created) throw new NotFoundError('The user could not be read back after creation')
    return created
  },

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await usersRepository.setPasswordHash(userId, passwordHash)
  },

  /**
   * Sets status without the administrative guards in `setStatus`.
   *
   * Reserved for the authentication flows that must be able to lock an account
   * on repeated failures and unlock it on a completed password reset. Those are
   * system decisions with no acting admin, so the "last owner" and
   * "not yourself" checks do not apply.
   */
  async setStatusUnchecked(userId: string, status: UserStatus): Promise<void> {
    await usersRepository.setStatus(userId, status)
    accessCache.invalidate(userId)
  },

  async markEmailVerified(userId: string): Promise<boolean> {
    const changed = await usersRepository.markEmailVerified(userId)
    if (changed) accessCache.invalidate(userId)
    return changed
  },

  async recordLogin(userId: string): Promise<void> {
    await usersRepository.recordLogin(userId)
  },

  async listRoles(): Promise<Role[]> {
    return usersRepository.listRoles()
  },

  async listStaff(options: { limit: number; offset: number }) {
    return usersRepository.listStaff(options)
  },

  /**
   * Replaces a user's roles. Refuses to remove the last active owner — an
   * account nobody can administer is unrecoverable without database access.
   */
  async replaceRoles(userId: string, roleKeys: string[], actor: Actor): Promise<User> {
    const target = await usersRepository.findById(userId)
    if (!target) throw new NotFoundError('User not found')

    const requested = [...new Set(roleKeys)]
    const known = await usersRepository.roleKeysExist(requested)
    const unknown = requested.filter((role) => !known.includes(role))
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown role(s): ${unknown.join(', ')}`)
    }

    const losingOwner = target.roles.includes('owner') && !requested.includes('owner')
    if (losingOwner && (await usersRepository.countUsersWithRole('owner')) <= 1) {
      throw new DomainRuleError(
        ERROR_CODES.LAST_OWNER_PROTECTED,
        'The last owner cannot have the owner role removed',
      )
    }
    if (requested.includes('owner') && !actor.hasRole('owner')) {
      throw new DomainRuleError(
        ERROR_CODES.ROLE_ASSIGNMENT_FORBIDDEN,
        'Only an owner may grant the owner role',
      )
    }

    await withTransaction(async () => {
      await usersRepository.replaceRoles(userId, requested, actor.userId)
      await publish(
        'user.roles_changed',
        {
          userId,
          added: requested.filter((r) => !target.roles.includes(r)),
          removed: target.roles.filter((r) => !requested.includes(r)),
          actorId: actor.userId,
        },
        { aggregateId: userId, actorUserId: actor.userId },
      )
    })

    accessCache.invalidate(userId)
    log.info({ userId, roles: requested, actorId: actor.userId }, 'roles changed')

    const updated = await usersRepository.findById(userId)
    if (!updated) throw new NotFoundError('User not found')
    return updated
  },

  /**
   * Enables or disables an account. Disabling revokes every session
   * immediately — leaving a disabled user with a live refresh token would make
   * "disabled" a suggestion rather than a control.
   */
  async setStatus(
    userId: string,
    status: UserStatus,
    actor: Actor,
    revokeSessions: (
      userId: string,
      reason: 'account_disabled' | 'admin_revoked',
    ) => Promise<number>,
  ): Promise<User> {
    const target = await usersRepository.findById(userId)
    if (!target) throw new NotFoundError('User not found')

    if (target.id === actor.userId && status !== 'active') {
      throw new ConflictError('You cannot disable your own account')
    }
    if (
      status !== 'active' &&
      target.roles.includes('owner') &&
      (await usersRepository.countUsersWithRole('owner')) <= 1
    ) {
      throw new DomainRuleError(
        ERROR_CODES.LAST_OWNER_PROTECTED,
        'The last active owner cannot be disabled',
      )
    }

    await withTransaction(async () => {
      await usersRepository.setStatus(userId, status)
      await publish(
        'user.status_changed',
        { userId, from: target.status, to: status, actorId: actor.userId },
        { aggregateId: userId, actorUserId: actor.userId },
      )
    })

    accessCache.invalidate(userId)

    if (status !== 'active') {
      const revoked = await revokeSessions(userId, 'account_disabled')
      log.info({ userId, status, revoked, actorId: actor.userId }, 'account disabled')
    }

    const updated = await usersRepository.findById(userId)
    if (!updated) throw new NotFoundError('User not found')
    return updated
  },

  /** Whether a set of role keys grants staff standing. */
  isStaff: isStaffRoles,

  /** Called by event subscribers and by tests when identity data changes. */
  invalidateAccess(userId: string): void {
    accessCache.invalidate(userId)
  },

  invalidatePermissionMatrix(): void {
    permissionMatrixCache.invalidate(PERMISSION_MATRIX_KEY)
  },

  /** Test seam: drops both caches. */
  clearCaches(): void {
    accessCache.clear()
    permissionMatrixCache.clear()
  },
}
