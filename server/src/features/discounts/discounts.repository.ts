/**
 * Discount data access.
 */

import { queryOne } from '../../infrastructure/database/query.js'
import type { Discount } from './discounts.types.js'

interface DiscountRow {
  id: string
  code: string
  title: string
  description: string | null
  discount_type: 'percentage' | 'fixed_amount'
  discount_percentage: number | null
  discount_amount_minor: number | null
  currency: string
  minimum_order_amount_minor: number | null
  maximum_discount_amount_minor: number | null
  is_active: boolean
  starts_at: string | null
  ends_at: string | null
  total_uses_limit: number | null
  total_uses: number
  uses_per_customer: number | null
  applies_to_subtotal: boolean
  created_at: string
  updated_at: string
}

function toDiscount(row: DiscountRow): Discount {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    discountType: row.discount_type,
    discountPercentage: row.discount_percentage,
    discountAmountMinor: row.discount_amount_minor,
    currency: row.currency,
    minimumOrderAmountMinor: row.minimum_order_amount_minor,
    maximumDiscountAmountMinor: row.maximum_discount_amount_minor,
    isActive: row.is_active,
    startsAt: row.starts_at ? new Date(row.starts_at) : null,
    endsAt: row.ends_at ? new Date(row.ends_at) : null,
    totalUsesLimit: row.total_uses_limit,
    totalUses: row.total_uses,
    usesPerCustomer: row.uses_per_customer,
    appliesToSubtotal: row.applies_to_subtotal,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export const discountsRepository = {
  async findActiveByCode(code: string): Promise<Discount | undefined> {
    const row = await queryOne<DiscountRow>(
      `SELECT *
       FROM discounts
       WHERE lower(code) = lower($1)
         AND is_active = true
         AND (starts_at IS NULL OR starts_at <= now())
         AND (ends_at IS NULL OR ends_at > now())
       LIMIT 1`,
      [code],
      { name: 'discounts.findActiveByCode' },
    )
    return row ? toDiscount(row) : undefined
  },

  async countCustomerRedemptions(discountId: string, customerId: string | null): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM coupon_redemptions
       WHERE discount_id = $1
         AND customer_id = $2`,
      [discountId, customerId],
      { name: 'discounts.countCustomerRedemptions' },
    )
    return row?.count ?? 0
  },

  async recordRedemption(input: {
    discountId: string
    customerId: string | null
    idempotencyKey: string
    redeemedAmountMinor: number
  }): Promise<void> {
    await queryOne(
      `INSERT INTO coupon_redemptions (id, discount_id, customer_id, idempotency_key, redeemed_amount_minor)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [input.discountId, input.customerId, input.idempotencyKey, input.redeemedAmountMinor],
      { name: 'discounts.recordRedemption' },
    )
  },
}
