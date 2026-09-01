/**
 * The Actor (§6.6).
 *
 * Who is making this request, and what may they do. Built once by
 * `authenticate` and read by everything downstream, so a controller never
 * assembles identity from request fields.
 *
 * Two questions stay separate:
 *   • roles/permissions answer "may this kind of actor do this kind of thing"
 *   • a feature policy answers "may this actor do it to *this* record"
 */
export type UserStatus = 'active' | 'disabled' | 'locked'

export const STAFF_ROLE_KEYS = ['staff', 'admin', 'owner'] as const
export type StaffRole = (typeof STAFF_ROLE_KEYS)[number]

export interface Actor {
  userId: string
  sessionId: string
  email: string
  status: UserStatus
  roles: readonly string[]
  permissions: ReadonlySet<string>
  emailVerified: boolean
  /** Anyone holding staff, admin or owner. */
  isStaff: boolean
  can(permission: string): boolean
  hasRole(role: string): boolean
}

export function isStaffRoles(roles: readonly string[]): boolean {
  return roles.some((role) => (STAFF_ROLE_KEYS as readonly string[]).includes(role))
}

export interface ActorInput {
  userId: string
  sessionId: string
  email: string
  status: UserStatus
  roles: readonly string[]
  permissions: ReadonlySet<string>
  emailVerified: boolean
}

export function createActor(input: ActorInput): Actor {
  return {
    ...input,
    isStaff: isStaffRoles(input.roles),
    can: (permission: string) => input.permissions.has(permission),
    hasRole: (role: string) => input.roles.includes(role),
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`; absent on unauthenticated routes. */
    actor?: Actor
  }
}
