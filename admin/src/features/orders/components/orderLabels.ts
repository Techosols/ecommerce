import type { BadgeTone } from '@/components/ui/Badge'
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from '../types/orders.types'

/**
 * The words and tones for the three status machines.
 *
 * Kept beside the badges rather than inside them because the timeline needs the
 * same vocabulary in prose — "Payment Unpaid → Paid" — and two lists of labels
 * that have to agree eventually stop agreeing.
 *
 * The tone carries meaning rather than decoration: amber is something waiting
 * on us, red is something that went wrong, green is settled, neutral is fine
 * and uninteresting.
 */
export const orderTones: Record<OrderStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'warning', label: 'Pending' },
  confirmed: { tone: 'info', label: 'Confirmed' },
  processing: { tone: 'info', label: 'Processing' },
  completed: { tone: 'positive', label: 'Completed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
}

export const paymentTones: Record<PaymentStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'warning', label: 'Unpaid' },
  authorized: { tone: 'info', label: 'Authorised' },
  paid: { tone: 'positive', label: 'Paid' },
  partially_refunded: { tone: 'warning', label: 'Part refunded' },
  refunded: { tone: 'neutral', label: 'Refunded' },
  failed: { tone: 'danger', label: 'Payment failed' },
  cancelled: { tone: 'neutral', label: 'Payment cancelled' },
}

export const fulfillmentTones: Record<FulfillmentStatus, { tone: BadgeTone; label: string }> = {
  unfulfilled: { tone: 'warning', label: 'Unfulfilled' },
  partially_fulfilled: { tone: 'info', label: 'Part shipped' },
  fulfilled: { tone: 'positive', label: 'Shipped' },
  delivered: { tone: 'positive', label: 'Delivered' },
  returned: { tone: 'neutral', label: 'Returned' },
}

/** The label for one value of one machine, for the timeline's prose. */
export function statusLabel(field: string, value: string): string {
  if (field === 'status') return orderTones[value as OrderStatus]?.label ?? value
  if (field === 'payment_status') return paymentTones[value as PaymentStatus]?.label ?? value
  return fulfillmentTones[value as FulfillmentStatus]?.label ?? value
}

/** Which machine moved. */
export function machineLabel(field: string): string {
  if (field === 'status') return 'Order'
  if (field === 'payment_status') return 'Payment'
  return 'Fulfilment'
}
