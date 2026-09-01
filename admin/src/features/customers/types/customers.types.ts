import type { RuleSet } from '@/components/rules'
import type { Money, OffsetQuery } from '@/types/api'

/**
 * The customer shapes, mirrored from `server/src/features/customers/customers.mapper.ts`.
 *
 * Two things about this model drive every screen built on it:
 *
 *   • **Consent is a state, not a checkbox.** `not_subscribed` (never asked)
 *     and `unsubscribed` (asked and refused) are both "not receiving email",
 *     and only the first may be asked again. The UI must never collapse them
 *     into one switch, because the switch is how shops end up mailing people
 *     who told them not to.
 *   • **The lifetime figures are the server's.** `ordersCount`, `totalSpent`
 *     and `averageOrderValue` are read, never derived here — the browser has
 *     one page of customers and none of their orders.
 */

export type MarketingState = 'not_subscribed' | 'pending' | 'subscribed' | 'unsubscribed'
export type OptInLevel = 'single_opt_in' | 'confirmed_opt_in' | 'unknown'
export type CustomerStatus = 'active' | 'disabled' | 'locked'

export interface CustomerSummary {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  emailVerified: boolean
  status: CustomerStatus
  tags: string[]
  adminNote: string | null
  taxExempt: boolean
  locale: string | null
  marketing: { email: MarketingState; sms: MarketingState; optInLevel: OptInLevel | null }
  ordersCount: number
  totalSpent: Money
  averageOrderValue: Money
  firstOrderAt: string | null
  lastOrderAt: string | null
  createdAt: string
}

export interface CustomerAddress {
  id: string
  label: string | null
  firstName: string
  lastName: string
  company: string | null
  line1: string
  line2: string | null
  city: string
  region: string | null
  postalCode: string | null
  countryCode: string
  phone: string | null
  isDefault: boolean
}

export interface CustomerDetail extends CustomerSummary {
  addresses: CustomerAddress[]
}

/**
 * One entry in the running record.
 *
 * `kind` is open on the server — system events are added by writing one — so
 * the UI labels the kinds it knows and falls back to the raw key rather than
 * hiding an entry it has not been taught about.
 */
export interface CustomerEvent {
  id: string
  kind: string
  body: string | null
  actorUserId: string | null
  actorName: string | null
  metadata: Record<string, unknown>
  at: string
}

export interface CustomerSegment {
  id: string
  name: string
  description: string | null
  rules: RuleSet
  isActive: boolean
  memberCount?: number
  summary?: string
  createdAt: string
  updatedAt: string
}

export interface SegmentPreview {
  memberCount: number
  summary: string
  sample: Array<{ id: string; email: string; name: string | null }>
}

export type CustomerSort = 'created' | 'spend' | 'orders' | 'lastOrder' | 'name'

export interface CustomerListParams extends OffsetQuery {
  q?: string
  status?: CustomerStatus
  hasOrders?: 'true' | 'false'
  acceptsMarketing?: 'true' | 'false'
  marketingEmailState?: MarketingState
  taxExempt?: 'true' | 'false'
  tags?: string[]
  minSpent?: number
  maxSpent?: number
  minOrders?: number
  maxOrders?: number
  createdAfter?: string
  createdBefore?: string
  lastOrderAfter?: string
  noOrderSince?: string
  segmentId?: string
  sort?: CustomerSort
  direction?: 'asc' | 'desc'
}

/** How a new customer gets in, if at all. */
export type CustomerAccess = 'invite' | 'password' | 'none'

export interface CreateCustomerInput {
  email: string
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  adminNote?: string | null
  tags?: string[]
  taxExempt?: boolean
  locale?: string | null
  marketingEmailState?: MarketingState
  access: CustomerAccess
  password?: string
}

export interface UpdateCustomerInput {
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  adminNote?: string | null
  taxExempt?: boolean
  locale?: string | null
}
