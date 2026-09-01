/**
 * Cart business logic (§9.1, docs/cart.md).
 *
 * The cart is the temporary commerce state. It stores what a customer intends
 * to purchase, in the exact configuration they selected, but it is never
 * authoritative for prices or availability.
 *
 * Critical rules:
 *   • Never reserve inventory here — reservation is an order-creation operation
 *   • Always recalculate prices from the current product/variant state
 *   • Validate all selections server-side
 *   • Guest carts use opaque tokens, never sequential IDs
 *   • Merging is transactional and deterministic
 */

import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { NotFoundError, DomainRuleError, ERROR_CODES, ValidationError } from '../../shared/errors/index.js'
import { resolvePrice } from '../catalogue/pricing.js'
import type { Money } from '../catalogue/catalogue.types.js'
import { cartRepository as repo } from './cart.repository.js'
import type {
  Cart,
  CartItem,
  CartItemRecord,
  CartRecord,
  AddToCartInput,
  CartMergeResult,
} from './cart.types.js'

const log = createLogger('cart.service')

// ── Pricing ──────────────────────────────────────────────────────────────

/**
 * Calculate totals for a set of items.
 * Today: simple sum. Later: discounts, fees, taxes.
 */
function calculateTotals(items: CartItem[]): {
  subtotal: Money
  discountTotal: Money
  feeTotal: Money
  total: Money
} {
  const currency = items[0]?.unitPrice.currency ?? 'USD'
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal.amount, 0)

  return {
    subtotal: { amount: subtotal, currency },
    discountTotal: { amount: 0, currency }, // Placeholder for discount feature
    feeTotal: { amount: 0, currency }, // Placeholder for fees
    total: { amount: subtotal, currency },
  }
}

/**
 * Resolve a cart item with current pricing and variant information.
 */
async function resolveCartItem(record: CartItemRecord): Promise<CartItem> {
  const variant = await repo.getVariantForCart(record.variantId)
  if (!variant) {
    throw new NotFoundError('Variant not found or has been removed')
  }

  const { price } = resolvePrice({
    priceAmount: variant.priceAmount,
    compareAtAmount: variant.compareAtAmount,
    currency: variant.currency,
  })

  const lineTotal: Money = {
    amount: price.amount * record.quantity,
    currency: price.currency,
  }

  return {
    id: record.id,
    variant: {
      id: variant.id,
      productId: variant.productId,
      title: variant.title,
      sku: variant.sku,
      isActive: variant.isActive,
      archivedAt: variant.archivedAt,
    },
    quantity: record.quantity,
    selectedOptions: record.selectedOptions,
    selectedModifiers: record.selectedModifiers,
    unitPrice: price,
    lineTotal,
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export const cartService = {
  /**
   * Get or create a customer's cart.
   *
   * A customer has exactly one active cart. If they don't have one, create it.
   */
  async ensureCustomerCart(customerId: string): Promise<CartRecord> {
    let cart = await repo.findCustomerCart(customerId)
    if (!cart) {
      cart = await repo.createCustomerCart(customerId)
      log.debug({ customerId }, 'created new customer cart')
    }
    return cart
  },

  /**
   * Create a new guest cart.
   *
   * Returns an opaque guest token that the client uses to access the cart.
   */
  async createGuestCart(): Promise<{ id: string; guestToken: string }> {
    const cart = await repo.createGuestCart()
    if (!cart.guestToken) {
      throw new Error('Guest token was not generated')
    }
    log.debug({ cartId: cart.id }, 'created new guest cart')
    return { id: cart.id, guestToken: cart.guestToken }
  },

  /**
   * Fetch a cart. Works for both authenticated and guest access.
   *
   * For authenticated users, pass actor.userId.
   * For guests, pass the guest token.
   * Returns null if the cart doesn't exist or doesn't belong to the requester.
   */
  async getCart(input: { cartId: string; guestToken?: string; customerId?: string }): Promise<Cart | null> {
    let record: CartRecord | undefined

    if (input.customerId) {
      // Verify this is their cart
      record = await repo.findCartById(input.cartId)
      if (!record || record.customerId !== input.customerId) {
        return null
      }
    } else if (input.guestToken) {
      // Verify the token matches
      record = await repo.findCartById(input.cartId)
      if (!record || record.guestToken !== input.guestToken) {
        return null
      }
    } else {
      return null
    }

    // Fetch items
    const itemRecords = await repo.findCartItems(record.id)
    const items: CartItem[] = []

    for (const itemRecord of itemRecords) {
      try {
        const item = await resolveCartItem(itemRecord)
        items.push(item)
      } catch (err) {
        // Item's variant is gone; skip it or mark for removal
        log.warn({ itemId: itemRecord.id, error: err }, 'cart item variant not found')
      }
    }

    const totals = calculateTotals(items)

    return {
      id: record.id,
      customerId: record.customerId,
      guestToken: record.guestToken,
      items,
      itemCount: items.length,
      ...totals,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  },

  /**
   * Add an item to a cart.
   *
   * Validates the variant exists, is active, and is published.
   * If an identical configuration already exists in the cart, increases
   * the quantity instead of creating a duplicate line.
   */
  async addToCart(input: {
    cartId: string
    guestToken?: string
    customerId?: string
    item: AddToCartInput
  }): Promise<Cart | null> {
    // Verify access
    let record = await repo.findCartById(input.cartId)
    if (!record) return null

    if (input.customerId && record.customerId !== input.customerId) {
      return null
    }
    if (input.guestToken && record.guestToken !== input.guestToken) {
      return null
    }

    // Validate the variant
    const variant = await repo.getVariantForCart(input.item.variantId)
    if (!variant) {
      throw new NotFoundError('Variant not found')
    }
    if (!variant.isActive) {
      throw new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'This variant is no longer available')
    }
    if (variant.archivedAt) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'This product has been discontinued',
      )
    }

    // Validate quantity
    if (input.item.quantity < 1 || input.item.quantity > 1_000_000) {
      throw new ValidationError('Quantity must be between 1 and 1,000,000')
    }

    const selectedOptions = input.item.selectedOptions ?? {}
    const selectedModifiers = input.item.selectedModifiers ?? {}

    await withTransaction(async () => {
      // Check for a duplicate item (same variant, same configuration)
      const existing = await repo.findCartItemByConfiguration({
        cartId: input.cartId,
        variantId: input.item.variantId,
        selectedOptions,
        selectedModifiers,
      })

      if (existing) {
        // Merge quantities
        const newQuantity = existing.quantity + input.item.quantity
        if (newQuantity > 1_000_000) {
          throw new ValidationError('Total quantity would exceed the maximum (1,000,000)')
        }
        await repo.updateCartItem(existing.id, newQuantity)
        log.debug({ itemId: existing.id, newQuantity }, 'merged quantity into existing cart item')
      } else {
        // Add new item
        await repo.addCartItem({
          cartId: input.cartId,
          variantId: input.item.variantId,
          quantity: input.item.quantity,
          selectedOptions,
          selectedModifiers,
        })
        log.debug({ variantId: input.item.variantId }, 'added item to cart')
      }

      // Extend cart expiry on modification
      await repo.extendCartExpiry(input.cartId)

      // Publish event
      await publish(
        'cart.item_added',
        {
          cartId: input.cartId,
          variantId: input.item.variantId,
          quantity: input.item.quantity,
        },
        { aggregateId: input.cartId },
      )
    })

    // Refetch the updated cart
    return this.getCart(input)
  },

  /**
   * Update a cart item's quantity.
   *
   * Quantity must be > 0. To remove an item, use removeFromCart.
   */
  async updateCartItem(input: {
    cartId: string
    itemId: string
    guestToken?: string
    customerId?: string
    quantity: number
  }): Promise<Cart | null> {
    // Verify access
    let record = await repo.findCartById(input.cartId)
    if (!record) return null

    if (input.customerId && record.customerId !== input.customerId) {
      return null
    }
    if (input.guestToken && record.guestToken !== input.guestToken) {
      return null
    }

    // Validate quantity
    if (input.quantity < 1 || input.quantity > 1_000_000) {
      throw new ValidationError('Quantity must be between 1 and 1,000,000')
    }

    // Verify the item belongs to this cart
    const item = await repo.findCartItem(input.itemId)
    if (!item || item.cartId !== input.cartId) {
      throw new NotFoundError('Cart item not found')
    }

    await withTransaction(async () => {
      await repo.updateCartItem(input.itemId, input.quantity)
      await repo.extendCartExpiry(input.cartId)

      await publish(
        'cart.item_updated',
        {
          cartId: input.cartId,
          itemId: input.itemId,
          quantity: input.quantity,
        },
        { aggregateId: input.cartId },
      )
    })

    return this.getCart(input)
  },

  /**
   * Remove an item from a cart.
   */
  async removeFromCart(input: {
    cartId: string
    itemId: string
    guestToken?: string
    customerId?: string
  }): Promise<Cart | null> {
    // Verify access
    let record = await repo.findCartById(input.cartId)
    if (!record) return null

    if (input.customerId && record.customerId !== input.customerId) {
      return null
    }
    if (input.guestToken && record.guestToken !== input.guestToken) {
      return null
    }

    // Verify the item belongs to this cart
    const item = await repo.findCartItem(input.itemId)
    if (!item || item.cartId !== input.cartId) {
      throw new NotFoundError('Cart item not found')
    }

    await withTransaction(async () => {
      await repo.removeCartItem(input.itemId)
      await repo.extendCartExpiry(input.cartId)

      await publish(
        'cart.item_removed',
        {
          cartId: input.cartId,
          itemId: input.itemId,
          variantId: item.variantId,
        },
        { aggregateId: input.cartId },
      )
    })

    return this.getCart(input)
  },

  /**
   * Clear all items from a cart.
   */
  async clearCart(input: {
    cartId: string
    guestToken?: string
    customerId?: string
  }): Promise<Cart | null> {
    // Verify access
    let record = await repo.findCartById(input.cartId)
    if (!record) return null

    if (input.customerId && record.customerId !== input.customerId) {
      return null
    }
    if (input.guestToken && record.guestToken !== input.guestToken) {
      return null
    }

    await withTransaction(async () => {
      await repo.clearCartItems(input.cartId)
      await repo.extendCartExpiry(input.cartId)

      await publish(
        'cart.cleared',
        {
          cartId: input.cartId,
        },
        { aggregateId: input.cartId },
      )
    })

    return this.getCart(input)
  },

  /**
   * Merge a guest cart into a customer cart when they sign in.
   *
   * Deterministic merge behavior:
   *   • If both carts have the same item (variant + configuration):
   *     - Sum the quantities (subject to inventory limits)
   *   • If only one cart has an item: include it
   *   • Remove the guest cart after merge
   */
  async mergeGuestCart(input: {
    guestToken: string
    customerId: string
  }): Promise<CartMergeResult> {
    const result: CartMergeResult = {
      mergedItemCount: 0,
      conflictedItems: [],
    }

    await withTransaction(async () => {
      // Find both carts
      const guestCart = await repo.findGuestCart(input.guestToken)
      if (!guestCart) {
        return // Guest cart doesn't exist or expired; nothing to merge
      }

      let customerCart = await repo.findCustomerCart(input.customerId)
      if (!customerCart) {
        customerCart = await repo.createCustomerCart(input.customerId)
      }

      // Fetch items from both
      const guestItems = await repo.findCartItems(guestCart.id)
      const customerItems = await repo.findCartItems(customerCart.id)

      // Merge each guest item into the customer cart
      for (const guestItem of guestItems) {
        const matching = customerItems.find(
          (ci) =>
            ci.variantId === guestItem.variantId &&
            JSON.stringify(ci.selectedOptions) === JSON.stringify(guestItem.selectedOptions) &&
            JSON.stringify(ci.selectedModifiers) === JSON.stringify(guestItem.selectedModifiers),
        )

        if (matching) {
          // Merge quantities
          const newQuantity = matching.quantity + guestItem.quantity
          result.conflictedItems.push({
            variantId: guestItem.variantId,
            guestQuantity: guestItem.quantity,
            customerQuantity: matching.quantity,
            resultingQuantity: newQuantity,
          })
          await repo.updateCartItem(matching.id, newQuantity)
        } else {
          // Transfer item (change cart_id)
          // Since we can't easily UPDATE to a different cart due to the unique constraint,
          // we delete and re-insert
          await repo.removeCartItem(guestItem.id)
          await repo.addCartItem({
            cartId: customerCart.id,
            variantId: guestItem.variantId,
            quantity: guestItem.quantity,
            selectedOptions: guestItem.selectedOptions,
            selectedModifiers: guestItem.selectedModifiers,
          })
          result.mergedItemCount++
        }
      }

      // Mark guest cart as merged
      await repo.markCartMerged(guestCart.id)

      log.info(
        {
          guestCartId: guestCart.id,
          customerCartId: customerCart.id,
          mergedItemCount: result.mergedItemCount,
          conflictedItemCount: result.conflictedItems.length,
        },
        'merged guest cart into customer cart',
      )

      // Publish event
      await publish(
        'cart.merged',
        {
          guestCartId: guestCart.id,
          customerCartId: customerCart.id,
          mergedItemCount: result.mergedItemCount,
          conflictedItemCount: result.conflictedItems.length,
        },
        { aggregateId: customerCart.id },
      )
    })

    return result
  },

  /**
   * Mark expired carts as abandoned. Called by a cleanup worker.
   */
  async cleanupExpiredCarts(): Promise<number> {
    const expiredCarts = await repo.findExpiredCarts()
    let count = 0

    for (const cart of expiredCarts) {
      await repo.markCartAbandoned(cart.id)
      count++

      await publish(
        'cart.expired',
        {
          cartId: cart.id,
          customerId: cart.customerId,
        },
        { aggregateId: cart.id },
      )
    }

    log.info({ count }, 'marked expired carts as abandoned')
    return count
  },
}
