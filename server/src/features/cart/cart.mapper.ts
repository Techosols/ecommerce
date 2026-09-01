/**
 * Cart DTO mappers (§9.2).
 *
 * Converts domain objects to client-safe response shapes.
 * Never exposes audit data, internal IDs, or payment secrets.
 */

import type { Cart, CartItem } from './cart.types.js'

interface MoneyDto {
  amount: number
  currency: string
}

function moneyDto(money: { amount: number; currency: string }): MoneyDto {
  return money
}

function cartItemDto(item: CartItem) {
  return {
    id: item.id,
    variant: {
      id: item.variant.id,
      title: item.variant.title,
      sku: item.variant.sku,
      // Don't expose internal product state (isActive, archivedAt) to the cart response
      // Cart should indicate availability separately if needed
    },
    quantity: item.quantity,
    selectedOptions: item.selectedOptions,
    selectedModifiers: item.selectedModifiers,
    unitPrice: moneyDto(item.unitPrice),
    lineTotal: moneyDto(item.lineTotal),
  }
}

/**
 * Storefront cart view — what customers see.
 */
export function storefrontCartDto(cart: Cart) {
  return {
    id: cart.id,
    // Only expose guestToken if this is a guest cart; never expose it in the ID
    ...(cart.guestToken ? { guestToken: cart.guestToken } : {}),
    items: cart.items.map((item) => cartItemDto(item)),
    itemCount: cart.itemCount,
    subtotal: moneyDto(cart.subtotal),
    discount: moneyDto(cart.discountTotal),
    fees: moneyDto(cart.feeTotal),
    total: moneyDto(cart.total),
    updatedAt: cart.updatedAt,
  }
}

/**
 * Minimal cart summary for quick checks (e.g., header).
 */
export function cartSummaryDto(cart: Cart) {
  return {
    id: cart.id,
    itemCount: cart.itemCount,
    total: moneyDto(cart.total),
  }
}
