import type { Money, OffsetQuery } from '@/types/api'

/**
 * Baskets that were left, and checkouts that were tried.
 *
 * Mirrored from `carts.admin.routes.ts` and the checkout-attempt routes in
 * `orders.admin.routes.ts`. Two things shape how these read:
 *
 *   • **A cart holds no money.** Its value is computed from what those items
 *     cost *now*, which is what recovering it would be worth today rather than
 *     what it was worth when somebody filled it.
 *   • **An attempt is a log line, not a session.** Nothing here is resumed or
 *     advanced; checkout is still one atomic request that either produces an
 *     order or refuses, and this is the record of which.
 */

export type CartStatus = 'active' | 'abandoned' | 'converted'

export interface CartSummary {
  id: string
  status: CartStatus
  customerId: string | null
  /** Null for a guest — a fact about the basket, not a missing field. */
  customerEmail: string | null
  customerName: string | null
  itemCount: number
  value: Money
  lastActivityAt: string
  expiresAt: string
  convertedOrderId: string | null
  createdAt: string
}

export interface CartLine {
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string | null
  sku: string | null
  imageUrl: string | null
  quantity: number
  unitPrice: Money
  lineTotal: Money
  purchasable: boolean
  /** Why it cannot be bought — often why the basket was left. */
  problem: string | null
}

export interface CartDetail {
  id: string
  status: CartStatus
  currency: string
  customer: { id: string; email: string; name: string | null } | null
  lines: CartLine[]
  totals: { subtotal: Money; itemCount: number }
  purchasable: boolean
  lastActivityAt: string
  expiresAt: string
  convertedOrderId: string | null
  createdAt: string
}

export interface CartListParams extends OffsetQuery {
  status?: CartStatus
  q?: string
  withItemsOnly?: 'false'
}

export interface RecoveryResult {
  sent: boolean
  to: string
  /** Present when the send was declined — an opt-out, not a failure. */
  reason?: string
}

// ── Checkout attempts ───────────────────────────────────────────────────────

export type AttemptOutcome = 'placed' | 'failed'

export interface CheckoutAttempt {
  id: string
  cartId: string | null
  customerId: string | null
  email: string | null
  orderId: string | null
  outcome: AttemptOutcome
  /** The server's own error code, which is what the reasons group by. */
  failureCode: string | null
  failureMessage: string | null
  subtotal: Money
  itemCount: number
  paymentMethod: string | null
  countryCode: string | null
  createdAt: string
}

export interface AttemptSummary {
  from: string
  to: string
  placed: number
  failed: number
  reasons: { code: string; count: number }[]
}

export interface AttemptListParams extends OffsetQuery {
  outcome?: AttemptOutcome
  failureCode?: string
  from?: string
  to?: string
}
