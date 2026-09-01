/**
 * Cart domain types (§9.1).
 *
 * A cart is a temporary container for purchase intent. It stores variant
 * selections and quantities, never prices or inventory reservations.
 *
 * Prices are recalculated on every cart read (they may have changed).
 * Inventory is validated at cart display but never consumed.
 * Only order creation captures prices and reserves stock.
 */

import type { Money } from '../catalogue/catalogue.types.js'

export type CartStatus = 'active' | 'merged' | 'abandoned'

/**
 * A line item in a cart.
 *
 * The variant is a reference to the current variant definition.
 * Options and modifiers preserve the customer's selections and can be used
 * to distinguish multiple lines containing the same variant.
 */
export interface CartItemRecord {
  id: string
  cartId: string
  variantId: string
  quantity: number
  selectedOptions: Record<string, string>
  selectedModifiers: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

/**
 * A cart item with resolved variant and pricing information.
 *
 * This is computed per read — it includes the current variant state and
 * current pricing, which may differ from when the item was added.
 */
export interface CartItem {
  id: string
  variant: {
    id: string
    productId: string
    title: string
    sku: string | null
    isActive: boolean
    archivedAt: Date | null
  }
  quantity: number
  selectedOptions: Record<string, string>
  selectedModifiers: Record<string, unknown>
  // Prices are recomputed live, always from the server
  unitPrice: Money
  lineTotal: Money
}

/**
 * A cart record (database row).
 */
export interface CartRecord {
  id: string
  customerId: string | null
  guestToken: string | null
  status: CartStatus
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
  guestMergedAt: Date | null
}

/**
 * A cart with resolved items and totals.
 */
export interface Cart {
  id: string
  customerId: string | null
  guestToken: string | null
  items: CartItem[]
  // Totals
  subtotal: Money
  discountTotal: Money
  feeTotal: Money
  total: Money
  itemCount: number
  // Metadata
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for adding an item to a cart.
 */
export interface AddToCartInput {
  variantId: string
  quantity: number
  selectedOptions?: Record<string, string>
  selectedModifiers?: Record<string, unknown>
}

/**
 * Input for updating a cart item quantity.
 */
export interface UpdateCartItemInput {
  quantity: number
}

/**
 * Result of a guest → customer cart merge.
 */
export interface CartMergeResult {
  mergedItemCount: number
  conflictedItems: Array<{
    variantId: string
    guestQuantity: number
    customerQuantity: number
    resultingQuantity: number
  }>
}
