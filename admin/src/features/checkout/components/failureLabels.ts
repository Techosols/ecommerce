import type { BadgeTone } from '@/components/ui/Badge'

/**
 * Why a checkout was refused, in words rather than in error codes.
 *
 * Keyed on the server's own codes because that is what the attempts are
 * recorded under and what the reasons chart groups by. Anything unmapped falls
 * back to a readable form of the code itself rather than to "unknown error",
 * which would hide exactly the failure worth looking at.
 */
export const FAILURE_LABELS: Record<string, string> = {
  INSUFFICIENT_STOCK: 'Ran out of stock',
  DISCOUNT_INVALID: 'The discount code was refused',
  DISCOUNT_EXPIRED: 'The discount code had expired',
  DISCOUNT_LIMIT_REACHED: 'The discount code was used up',
  SHIPPING_UNAVAILABLE: 'Nothing ships to that address',
  NO_SHIPPING_METHOD: 'No delivery option was chosen',
  PAYMENT_METHOD_UNAVAILABLE: 'That payment method was not allowed',
  COD_NOT_ALLOWED: 'Cash on delivery was refused',
  VALIDATION_FAILED: 'The details were incomplete',
  DOMAIN_RULE_VIOLATION: 'A shop rule refused it',
  CONFLICT: 'The basket changed mid-checkout',
  ACCOUNT_DISABLED: 'The account is disabled',
  INTERNAL_ERROR: 'Something went wrong on our side',
}

export function failureLabel(code: string | null): string {
  if (!code) return 'Refused'
  return FAILURE_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ')
}

/**
 * How alarming a failure is.
 *
 * `INTERNAL_ERROR` is the only one in red: every other code is the shop
 * working as designed — a code that expired, an address nobody ships to — and
 * colouring those as errors trains people to ignore the one that is not.
 */
export function failureTone(code: string | null): BadgeTone {
  if (code === 'INTERNAL_ERROR') return 'danger'
  if (code === 'INSUFFICIENT_STOCK') return 'warning'
  return 'neutral'
}

/** "4 days ago" is not the point; how long a basket has sat still is. */
export function idleFor(lastActivityAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(lastActivityAt).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hr`
  return `${Math.round(hours / 24)} days`
}

/** 0 of 0 is not 0% — it is a question with no answer yet. */
export function successRate(placed: number, failed: number): string {
  const total = placed + failed
  if (total === 0) return '—'
  return `${Math.round((placed / total) * 100)}%`
}
