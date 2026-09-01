import { Badge } from '@/components/ui/Badge'
import { fulfillmentTones, orderTones, paymentTones } from './orderLabels'
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from '../types/orders.types'

/**
 * Three badges, because there are three status machines.
 *
 * Collapsing them into one word is what the storefront does, and it is wrong
 * here: "paid but unshipped" and "shipped but unpaid" are different mornings'
 * work, and an operator scanning a list needs to tell them apart at a glance.
 *
 * The tone carries meaning rather than decoration — amber is something waiting
 * on us, red is something that went wrong or stopped, green is settled.
 */

export function OrderStatusBadge({ status, size }: { status: OrderStatus; size?: 'sm' }) {
  const { tone, label } = orderTones[status]
  return (
    <Badge tone={tone} {...(size ? { size } : {})}>
      {label}
    </Badge>
  )
}

export function PaymentStatusBadge({ status, size }: { status: PaymentStatus; size?: 'sm' }) {
  const { tone, label } = paymentTones[status]
  return (
    <Badge tone={tone} {...(size ? { size } : {})}>
      {label}
    </Badge>
  )
}

export function FulfillmentStatusBadge({
  status,
  size,
}: {
  status: FulfillmentStatus
  size?: 'sm'
}) {
  const { tone, label } = fulfillmentTones[status]
  return (
    <Badge tone={tone} {...(size ? { size } : {})}>
      {label}
    </Badge>
  )
}

/** The three together, as they appear beside an order number. */
export function OrderStatusTriple({
  status,
  paymentStatus,
  fulfillmentStatus,
  size,
}: {
  status: OrderStatus
  paymentStatus: PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  size?: 'sm'
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <OrderStatusBadge status={status} {...(size ? { size } : {})} />
      <PaymentStatusBadge status={paymentStatus} {...(size ? { size } : {})} />
      {/* A cancelled order was never shipped and never will be; showing
          "Unfulfilled" beside "Cancelled" reads as work still outstanding. */}
      {status === 'cancelled' ? null : (
        <FulfillmentStatusBadge status={fulfillmentStatus} {...(size ? { size } : {})} />
      )}
    </span>
  )
}
