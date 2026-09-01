/**
 * Room naming and join authorisation (§11.3).
 *
 * Rooms a socket joins automatically are derived server-side from the verified
 * token — the client never says who it is. The only room a client may ask to
 * join is `order:<id>`, and that request is authorised against the same policy
 * the HTTP read uses.
 */
export const ROOMS = {
  /** Every staff member. */
  admin: () => 'admin',
  adminOrders: () => 'admin:orders',
  adminInventory: () => 'admin:inventory',
  adminPayments: () => 'admin:payments',
  /** One room per user, for notifications addressed to a person. */
  user: (userId: string) => `user:${userId}`,
  /** One room per order, joined by its customer and by staff. */
  order: (orderId: string) => `order:${orderId}`,
} as const

export const STAFF_ROLES = ['staff', 'admin', 'owner'] as const

export function isStaff(roles: readonly string[]): boolean {
  return roles.some((role) => (STAFF_ROLES as readonly string[]).includes(role))
}

/**
 * Rooms joined automatically on connection, from the verified claims only.
 * Order-scoped rooms are joined on request, not here.
 */
export function autoJoinRooms(
  namespace: 'storefront' | 'admin',
  claims: {
    sub: string
    roles: string[]
  },
): string[] {
  if (namespace === 'admin') {
    if (!isStaff(claims.roles)) return []
    return [
      ROOMS.admin(),
      ROOMS.adminOrders(),
      ROOMS.adminInventory(),
      ROOMS.adminPayments(),
      ROOMS.user(claims.sub),
    ]
  }
  return [ROOMS.user(claims.sub)]
}
