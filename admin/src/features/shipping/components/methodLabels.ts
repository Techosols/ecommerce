import { formatMoney } from '@/lib/format'
import type { ShippingMethod } from '../types/shipping.types'

/**
 * A method's whole rule as one line.
 *
 * Four fields decide what a shopper is charged and whether they are offered the
 * method at all, and reading them from four columns means holding them in your
 * head. Written out in order — price, threshold, band, estimate — the rule can
 * be checked at a glance.
 */

/** "Standard · £4.99, free over £50 · 0–2 kg · 2–4 days" — the whole rule, in a line. */
export function describeMethod(method: ShippingMethod, currency: string): string {
  const money = (amount: number) => formatMoney({ amount, currency: currency || 'GBP' })
  const parts: string[] = []

  if (method.rateType === 'free') parts.push('Free')
  else if (method.rateType === 'weight_based') parts.push(`${money(method.priceCents)} per kg`)
  else parts.push(money(method.priceCents))

  if (method.freeOverSubtotalCents !== null) {
    parts.push(`free over ${money(method.freeOverSubtotalCents)}`)
  }

  if (method.minWeightGrams !== null || method.maxWeightGrams !== null) {
    const from = (method.minWeightGrams ?? 0) / 1000
    const to = method.maxWeightGrams === null ? '∞' : method.maxWeightGrams / 1000
    parts.push(`${from}–${to} kg`)
  }

  if (method.estimatedDaysMin !== null) {
    const to = method.estimatedDaysMax ?? method.estimatedDaysMin
    parts.push(
      method.estimatedDaysMin === to
        ? `${to} day${to === 1 ? '' : 's'}`
        : `${method.estimatedDaysMin}–${to} days`,
    )
  }

  return parts.join(' · ')
}
