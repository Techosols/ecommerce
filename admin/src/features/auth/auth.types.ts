/**
 * Mirrors `server/src/features/auth/auth.mapper.ts`.
 *
 * `permissions` is the server's own note about what it has already decided to
 * allow. The admin uses it to decide what to *render*; the server decides what
 * to *allow*, on every request, regardless of what this array says.
 */

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

export interface CurrentUser extends UserDto {
  permissions: string[]
  isStaff: boolean
  sessionId: string
}

export interface TokenDto {
  accessToken: string
  tokenType: 'Bearer'
  /** Seconds until the access token expires. */
  expiresIn: number
}

export interface LoginResponse extends TokenDto {
  user: CurrentUser
}

export interface SessionDto {
  id: string
  current: boolean
  userAgent: string | null
  ip: string | null
  createdAt: string
  expiresAt: string
}

export interface LoginInput {
  email: string
  password: string
}

/**
 * The permission strings the server seeds, as a type.
 *
 * Listing them makes a typo in `<RequirePermission permission="orders:raed">`
 * a compile error rather than a page that silently never renders. It is a copy
 * of `migrations/0004_identity_and_access.sql`.
 */
export const PERMISSIONS = [
  'catalog:read',
  'catalog:write',
  'catalog:publish',
  'inventory:read',
  'inventory:adjust',
  'inventory:transfer',
  'inventory:manage',
  'orders:read',
  'orders:write',
  'orders:cancel',
  'orders:refund',
  'returns:read',
  'returns:write',
  'shipping:read',
  'shipping:write',
  'payments:read',
  'payments:capture',
  'payments:refund',
  'customers:read',
  'customers:write',
  'customers:impersonate',
  'discounts:read',
  'discounts:write',
  'analytics:read',
  'reports:generate',
  'settings:read',
  'settings:write',
  'staff:read',
  'staff:write',
  'roles:assign',
  'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * Which roles hold which permissions, for reference while reading the UI.
 *
 * `staff` is the narrow one and the reason permission gating is not optional
 * decoration: a staff account has no `analytics:read`, `discounts:*`,
 * `settings:*` or `catalog:write`, so several sidebar entries and the whole
 * dashboard analytics panel are genuinely unavailable to them. Copied from
 * `migrations/0004_identity_and_access.sql`; the server remains authoritative.
 */
export const STAFF_ROLES = ['staff', 'admin', 'owner'] as const
export type StaffRole = (typeof STAFF_ROLES)[number]
