import type { OffsetQuery } from '@/types/api'

/**
 * Store settings, staff, roles and the audit trail — mirrored from
 * `server/src/features/settings/settings.admin.routes.ts`,
 * `users.admin.routes.ts` and `audit.admin.routes.ts`.
 *
 * Two shapes to keep straight:
 *
 *   • **Money is minor units.** `codFeeCents` and the two COD thresholds are
 *     integers, like every other price in this admin.
 *   • **Tax is basis points.** `taxRateBps` is 875 for 8.75% — hundredths of a
 *     percent, so a rate like 8.75 survives without a float anywhere. The one
 *     place it becomes a percentage is the input that renders it.
 */

export interface StoreSettings {
  storeName: string
  contactEmail: string
  supportUrl: string | null
  supportPhone: string | null
  currency: string
  timezone: string
  weightUnit: 'g' | 'kg' | 'lb' | 'oz'
  taxRateBps: number
  pricesIncludeTax: boolean
  defaultLowStockThreshold: number
  orderNumberPrefix: string
  reservationTtlMinutes: number
  guestCheckoutEnabled: boolean

  // Cash on delivery. Each of these is a way COD loses money, which is why
  // they are settings and not constants.
  codEnabled: boolean
  codMinSubtotalCents: number
  codMaxSubtotalCents: number | null
  codFeeCents: number
  codCountryCodes: string[]
  codRequiresAccount: boolean
  codMaxOpenOrders: number | null

  /** How long a *placed order* holds stock — not the cart hold. */
  orderReservationHours: number

  logoMediaId: string | null
  metadata: Record<string, unknown>
  updatedAt: string
  updatedBy: string | null
}

/** Everything is optional: the admin sends only what the operator changed. */
export type StoreSettingsPatch = Partial<Omit<StoreSettings, 'updatedAt' | 'updatedBy'>>

// ── Staff and roles ─────────────────────────────────────────────────────────

export type StaffStatus = 'active' | 'disabled' | 'pending'

export interface StaffMember {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  status: string
  emailVerified: boolean
  roles: string[]
  lastLoginAt: string | null
  createdAt: string
}

export interface Role {
  key: string
  name: string
  description: string
  permissions: string[]
}

export interface InviteStaffInput {
  email: string
  roles: string[]
  firstName?: string
  lastName?: string
}

// ── The audit trail ─────────────────────────────────────────────────────────

export interface AuditRecord {
  id: string
  action: string
  resourceType: string
  resourceId: string | null
  actor: {
    userId: string | null
    email: string | null
    roles: string[]
    ip: string | null
  }
  /** Only the fields that changed, as the server recorded them. */
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  requestId: string | null
  createdAt: string
}

export interface AuditQuery extends OffsetQuery {
  actorUserId?: string
  action?: string
  resourceType?: string
  resourceId?: string
  from?: string
  to?: string
}

// ── The operator's own account ──────────────────────────────────────────────

export interface Session {
  id: string
  /** The session this browser is using. It is revoked by signing out, not here. */
  current: boolean
  userAgent: string | null
  ip: string | null
  createdAt: string
  expiresAt: string
}
