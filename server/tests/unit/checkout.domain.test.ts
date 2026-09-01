import { describe, expect, it } from 'vitest'
import { discountsService } from '../../src/features/discounts/discounts.service.js'
import { checkoutService } from '../../src/features/checkout/checkout.service.js'

describe('checkout domain', () => {
  it('applies a fixed-amount discount to a subtotal in minor units', async () => {
    const result = discountsService.calculateForSubtotal({
      subtotalMinor: 1500,
      currency: 'USD',
      code: 'SAVE10',
      discount: {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'SAVE10',
        title: 'Save $10',
        description: null,
        discountType: 'fixed_amount',
        discountPercentage: null,
        discountAmountMinor: 1000,
        currency: 'USD',
        minimumOrderAmountMinor: 500,
        maximumDiscountAmountMinor: null,
        isActive: true,
        startsAt: null,
        endsAt: null,
        totalUsesLimit: null,
        totalUses: 0,
        usesPerCustomer: null,
        appliesToSubtotal: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(result.appliedAmountMinor).toBe(1000)
    expect(result.discountCode).toBe('SAVE10')
  })

  it('rejects checkout creation when the cart is empty', async () => {
    await expect(
      checkoutService.create({
        cartId: '22222222-2222-4222-8222-222222222222',
        email: 'customer@example.com',
        fulfillmentMethod: 'pickup',
        idempotencyKey: 'idempotent-1',
      }),
    ).rejects.toThrow('Cart is empty')
  })
})
