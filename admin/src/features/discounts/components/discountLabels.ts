import type { BadgeTone } from '@/components/ui/Badge'
import { formatMoney } from '@/lib/format'
import type {
  DiscountAppliesTo,
  DiscountStatus,
  DiscountSummary,
  DiscountType,
} from '../types/discounts.types'

/**
 * The words and arithmetic the discount screens share.
 *
 * All of it turns on one thing: **`value` means two units.** Basis points for a
 * percentage, minor units for a fixed amount, nothing at all for free shipping.
 * Every function here takes the type first for that reason, and nothing in the
 * feature formats `value` without going through one of them.
 */

export const TYPE_LABELS: Record<DiscountType, string> = {
  percentage: 'Percentage off',
  fixed_amount: 'Amount off',
  free_shipping: 'Free delivery',
}

export const APPLIES_TO_LABELS: Record<DiscountAppliesTo, string> = {
  order: 'The whole order',
  products: 'Chosen products',
  categories: 'Chosen categories',
}

export const STATUS_LABELS: Record<DiscountStatus, string> = {
  active: 'Active',
  scheduled: 'Scheduled',
  expired: 'Expired',
  exhausted: 'Used up',
  inactive: 'Off',
  archived: 'Archived',
}

/**
 * Only a working code is green.
 *
 * `scheduled` is deliberately not positive: a code that is not live yet looks
 * like a working one at a glance, and that is the misreading that has somebody
 * putting an unusable code on a poster.
 */
export const STATUS_TONES: Record<DiscountStatus, BadgeTone> = {
  active: 'positive',
  scheduled: 'info',
  expired: 'neutral',
  exhausted: 'warning',
  inactive: 'neutral',
  archived: 'neutral',
}

/** 2500 → "25%". Trailing zeros dropped, so a flat 10% is not "10.00%". */
export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)))
}

export function percentToBps(percent: string): number {
  const value = Number(percent)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(value * 100)
}

/** What the code takes off: "25%", "£5.00", "Free delivery". */
export function describeValue(
  discount: Pick<DiscountSummary, 'type' | 'value'>,
  currency: string,
): string {
  if (discount.type === 'free_shipping') return 'Free delivery'
  if (discount.type === 'percentage') return `${bpsToPercent(discount.value)}%`
  return formatMoney({ amount: discount.value, currency: currency || 'GBP' })
}

/**
 * The whole rule in one line: what it takes off, from what, and on what terms.
 *
 * Written out rather than spread over four columns, because the conditions are
 * what decide whether a code works and reading them separately means holding
 * four things in your head at once.
 */
export function describeTerms(discount: DiscountSummary, currency: string): string {
  const money = (amount: number) => formatMoney({ amount, currency: currency || 'GBP' })
  const parts: string[] = [describeValue(discount, currency)]

  if (discount.appliesTo !== 'order') {
    parts.push(discount.appliesTo === 'products' ? 'on chosen products' : 'on chosen categories')
  }
  if (discount.minSubtotalCents > 0) parts.push(`over ${money(discount.minSubtotalCents)}`)
  if (discount.requiresCustomer) parts.push('signed-in customers')

  return parts.join(' · ')
}

/** "47 of 100 used", or just "47 used" when the code has no ceiling. */
export function describeUsage(discount: Pick<DiscountSummary, 'usageCount' | 'usageLimitTotal'>): string {
  return discount.usageLimitTotal === null
    ? `${discount.usageCount} used`
    : `${discount.usageCount} of ${discount.usageLimitTotal} used`
}
