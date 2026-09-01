import type { Money, OffsetQuery } from '@/types/api'

/**
 * Discounts, mirrored from `server/src/features/discounts/discounts.admin.routes.ts`.
 *
 * The one thing to keep straight: **`value` means two different things.** A
 * percentage carries basis points — 2500 is 25% — and a fixed amount carries
 * minor units. That is why the server's create schema is a discriminated union
 * and why nothing in this admin renders `value` without first asking `type`.
 * A screen that showed "2500" beside a percentage sign would be off by a
 * hundred, and the mistake would look like a typo rather than a bug.
 */

export type DiscountType = 'percentage' | 'fixed_amount' | 'free_shipping'

export type DiscountAppliesTo = 'order' | 'products' | 'categories'

/**
 * Why a code is or is not working, decided by the server.
 *
 * Six columns say whether a code applies, and the console does not re-derive
 * them: this is the same answer the eligibility check gives when it refuses
 * one at checkout.
 */
export type DiscountStatus =
  | 'active'
  | 'scheduled'
  | 'expired'
  | 'exhausted'
  | 'inactive'
  | 'archived'

export interface DiscountSummary {
  id: string
  code: string
  title: string
  type: DiscountType
  /** Basis points for a percentage, minor units for a fixed amount, 0 for free shipping. */
  value: number
  appliesTo: DiscountAppliesTo
  minSubtotalCents: number
  startsAt: string | null
  endsAt: string | null
  usageLimitTotal: number | null
  usageLimitPerCustomer: number | null
  usageCount: number
  requiresCustomer: boolean
  isActive: boolean
  status: DiscountStatus
  archivedAt: string | null
  createdAt: string
}

/** The detail read adds the scope. The list deliberately does not carry it. */
export interface DiscountDetail extends DiscountSummary {
  productIds: string[]
  categoryIds: string[]
}

export interface Redemption {
  id: string
  orderId: string
  orderNumber: string | null
  customerId: string | null
  customerEmail: string | null
  amount: Money
  createdAt: string
}

export interface DiscountListParams extends OffsetQuery {
  q?: string
  status?: DiscountStatus
  includeArchived?: 'true'
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creating one. `code` and `type` are here and absent from the patch below,
 * which is the whole distinction: an order citing SUMMER25 as a percentage
 * must keep meaning that, so retyping a live code is a new code, not an edit.
 */
export interface CreateDiscountInput {
  code: string
  title: string
  type: DiscountType
  value?: number
  appliesTo?: DiscountAppliesTo
  minSubtotalCents?: number
  startsAt?: string | null
  endsAt?: string | null
  usageLimitTotal?: number | null
  usageLimitPerCustomer?: number | null
  requiresCustomer?: boolean
  productIds?: string[]
  categoryIds?: string[]
}

export interface UpdateDiscountInput {
  title?: string
  value?: number
  appliesTo?: DiscountAppliesTo
  productIds?: string[]
  categoryIds?: string[]
  minSubtotalCents?: number
  startsAt?: string | null
  endsAt?: string | null
  usageLimitTotal?: number | null
  usageLimitPerCustomer?: number | null
  requiresCustomer?: boolean
  isActive?: boolean
}
