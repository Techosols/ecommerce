/**
 * Cart domain types (§5.11).
 *
 * A cart stores *what* and *how many*, never *how much*. Prices are resolved
 * from the catalogue every time the cart is read, so a basket left open for
 * three days shows today's price and a client can never quote one.
 */
import type { Money } from '../catalogue/index.js'
import type { AvailabilityState } from '../inventory/index.js'

export type CartStatus = 'active' | 'converted' | 'abandoned'

export interface Cart {
  id: string
  customerId: string | null
  status: CartStatus
  currency: string
  convertedOrderId: string | null
  lastActivityAt: Date
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface CartItem {
  id: string
  cartId: string
  variantId: string
  quantity: number
  addedAt: Date
}

/** A cart line resolved against the catalogue and inventory, right now. */
export interface ResolvedCartLine {
  id: string
  variantId: string
  productId: string
  handle: string
  productTitle: string
  variantTitle: string
  sku: string | null
  options: { name: string; value: string }[]
  imageUrl: string | null
  quantity: number
  unitPrice: Money
  lineTotal: Money
  requiresShipping: boolean
  weightGrams: number
  /** False when the variant went away, was deactivated, or ran out. */
  purchasable: boolean
  availability: AvailabilityState
  /** Set when the line cannot be bought as-is, in words a shopper understands. */
  problem: string | null
}

export interface CartTotals {
  subtotal: Money
  discountTotal: Money
  taxTotal: Money
  shippingTotal: Money
  total: Money
  itemCount: number
}

export interface ResolvedCart {
  cart: Cart
  lines: ResolvedCartLine[]
  totals: CartTotals
  /** True when every line can be bought. Checkout refuses otherwise. */
  purchasable: boolean
}

export interface CartIdentity {
  cartId?: string
  customerId?: string
  anonymousToken?: string
}
