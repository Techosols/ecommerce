/**
 * Customer domain types (CLAUDE.md §12).
 *
 * A *customer* is a `users` row holding the `customer` role. There is no second
 * table: duplicating identity is how two records of the same person drift apart
 * (§12, "Do not unnecessarily duplicate customer data").
 */

export interface Address {
  id: string
  userId: string
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
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

/** The address shape an order snapshots. No id: it is a copy, not a reference. */
export interface AddressSnapshot {
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
}

/**
 * Consent, per channel.
 *
 * `not_subscribed` (never said yes) and `unsubscribed` (said no) are different
 * answers: the first may be asked, the second must not be. A boolean collapses
 * them, which is how shops mail people who opted out.
 */
export type MarketingState = 'not_subscribed' | 'pending' | 'subscribed' | 'unsubscribed'

export const MARKETING_STATES: readonly MarketingState[] = [
  'not_subscribed',
  'pending',
  'subscribed',
  'unsubscribed',
]

export type OptInLevel = 'single_opt_in' | 'confirmed_opt_in' | 'unknown'

export interface CustomerSummary {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  status: string
  emailVerified: boolean
  /** Derived from `marketingEmailState`. Never written directly. */
  acceptsMarketing: boolean
  marketingEmailState: MarketingState
  marketingSmsState: MarketingState
  marketingOptInLevel: string | null
  tags: string[]
  adminNote: string | null
  taxExempt: boolean
  locale: string | null
  ordersCount: number
  totalSpentCents: number
  firstOrderAt: Date | null
  lastOrderAt: Date | null
  createdAt: Date
}

/** One thing that happened to a customer, or one thing staff wrote down. */
export interface CustomerEvent {
  id: string
  customerId: string
  kind: string
  body: string | null
  actorUserId: string | null
  actorName: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export const CUSTOMER_SORTS = ['created', 'spend', 'orders', 'lastOrder', 'name'] as const
export type CustomerSort = (typeof CUSTOMER_SORTS)[number]

export interface CustomerListFilter {
  query?: string
  status?: string
  hasOrders?: boolean
  acceptsMarketing?: boolean
  marketingEmailState?: MarketingState
  taxExempt?: boolean
  tags?: string[]
  minSpentCents?: number
  maxSpentCents?: number
  minOrders?: number
  maxOrders?: number
  createdAfter?: string
  createdBefore?: string
  lastOrderAfter?: string
  /** "Nothing since": customers whose last order is older than this, or none. */
  noOrderSince?: string
  segmentId?: string
  sort?: CustomerSort
  direction?: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface AddressInput {
  label?: string | null
  firstName: string
  lastName: string
  company?: string | null
  line1: string
  line2?: string | null
  city: string
  region?: string | null
  postalCode?: string | null
  countryCode: string
  phone?: string | null
  isDefault?: boolean
}
