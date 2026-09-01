/**
 * Checkout orchestration for the cart-to-order transition.
 */

import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { DomainRuleError, ERROR_CODES, NotFoundError, ValidationError } from '../../shared/errors/index.js'
import { cartRepository } from '../cart/cart.repository.js'
import { discountsService } from '../discounts/discounts.service.js'
import { inventoryService, reservationsService } from '../inventory/index.js'
import type { Checkout, CheckoutCreateInput } from './checkout.types.js'
import { checkoutRepository } from './checkout.repository.js'

export const checkoutService = {
  async create(
    input: CheckoutCreateInput & {
      customerId?: string | null
      guestToken?: string | null
    },
  ): Promise<Checkout> {
    if (!input.idempotencyKey) {
      throw new ValidationError('An idempotency key is required')
    }

    const existing = await checkoutRepository.findByIdempotencyKey(input.idempotencyKey)
    if (existing) return existing

    const cart = await cartRepository.findCartById(input.cartId)
    if (!cart) {
      throw new NotFoundError('Cart not found')
    }

    const itemRows = await cartRepository.findCartItems(cart.id)
    if (itemRows.length === 0) {
      throw new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'Cart is empty')
    }

    let subtotalMinor = 0
    for (const item of itemRows) {
      const variant = await cartRepository.getVariantForCart(item.variantId)
      if (!variant) {
        throw new NotFoundError('Cart item variant was removed')
      }
      if (!variant.isActive || variant.archivedAt) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          'A cart item is no longer available',
        )
      }
      subtotalMinor += variant.priceAmount * item.quantity
    }

    let discountId: string | null = null
    let orderDiscountMinor = 0
    let discountCode: string | null = null

    if (input.discountCode) {
      const discount = await discountsService.findActiveByCode(input.discountCode)
      if (discount) {
        const result = discountsService.calculateForSubtotal({
          subtotalMinor,
          currency: 'USD',
          code: discount.code,
          discount,
        })
        discountId = discount.id
        orderDiscountMinor = result.appliedAmountMinor
        discountCode = discount.code
      }
    }

    const deliveryFeeMinor = input.fulfillmentMethod === 'delivery' ? 0 : 0
    const itemsTotalMinor = subtotalMinor
    const totalMinor = subtotalMinor - orderDiscountMinor + deliveryFeeMinor

    const checkout = await withTransaction(async () => {
      const created = await checkoutRepository.create({
        customerId: input.customerId ?? null,
        guestToken: input.guestToken ?? null,
        idempotencyKey: input.idempotencyKey,
        cartId: cart.id,
        email: input.email,
        phoneNumber: input.phoneNumber ?? null,
        fulfillmentMethod: input.fulfillmentMethod,
        pickupLocationId: input.pickupLocationId ?? null,
        deliveryAddress: input.deliveryAddress ?? null,
        deliveryFeeMinor,
        subtotalMinor,
        itemsTotalMinor,
        orderDiscountMinor,
        deliveryFeeTotalMinor: deliveryFeeMinor,
        taxesMinor: 0,
        totalMinor,
        currency: 'USD',
        discountId,
        discountCode,
      })

      for (const item of itemRows) {
        try {
          const target = await inventoryService.resolveTarget({ variantId: item.variantId })
          if (target.item.trackInventory) {
            await reservationsService.reserve(
              {
                variantId: item.variantId,
                quantity: item.quantity,
                ownerType: 'cart',
                ownerId: cart.id,
              },
              null,
            )
          }
        } catch (error) {
          if (error instanceof DomainRuleError) {
            throw error
          }
        }
      }

      await publish(
        'checkout.created',
        {
          checkoutId: created.id,
          cartId: cart.id,
          customerId: input.customerId ?? null,
          totalMinor: created.totalMinor,
        },
        { aggregateId: created.id },
      )

      return created
    })

    const updated = await checkoutRepository.updateStatus(checkout.id, 'payment_pending')
    return updated ?? checkout
  },
} 
