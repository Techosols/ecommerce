/**
 * Discount domain types.
 */

export type DiscountType = 'percentage' | 'fixed_amount'

export interface Discount {
  id: string
  code: string
  title: string
  description: string | null
  discountType: DiscountType
  discountPercentage: number | null
  discountAmountMinor: number | null
  currency: string
  minimumOrderAmountMinor: number | null
  maximumDiscountAmountMinor: number | null
  isActive: boolean
  startsAt: Date | null
  endsAt: Date | null
  totalUsesLimit: number | null
  totalUses: number
  usesPerCustomer: number | null
  appliesToSubtotal: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DiscountApplicationResult {
  discountId: string
  discountCode: string
  appliedAmountMinor: number
  reason: string
}
