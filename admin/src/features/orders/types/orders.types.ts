import type { Money, OffsetQuery } from '@/types/api'

/**
 * The order shapes, mirrored from `server/src/features/orders/orders.mapper.ts`.
 *
 * Three things about this model drive every screen built on it:
 *
 *   • **Three status machines, not one.** `status`, `paymentStatus` and
 *     `fulfillmentStatus` move independently, because real states — paid but
 *     unshipped, shipped but partly refunded — are inexpressible in a single
 *     column. `displayStatus` is the flat word derived from all three for a
 *     customer; the admin shows the three.
 *   • **Lines are snapshots.** Title, SKU and unit price were copied at
 *     purchase. They are what was bought, not what the catalogue says today,
 *     and the page must never "correct" them against a live product.
 *   • **Money is an integer of minor units** on the wire, always paired with
 *     its currency. Nothing here is a float and nothing is recomputed in the
 *     browser — the totals shown are the totals the server holds.
 */

export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'completed' | 'cancelled'

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed'
  | 'cancelled'

export type FulfillmentStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'delivered'
  | 'returned'

export interface OrderSummary {
  id: string
  orderNumber: string
  customerId: string | null
  email: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  displayStatus: string
  total: Money
  refundedTotal: Money
  tags: string[]
  paymentMethod: string
  source: 'storefront' | 'admin'
  placedAt: string
}

export interface OrderItem {
  id: string
  productTitle: string
  variantTitle: string
  sku: string | null
  imageUrl: string | null
  options: { name: string; value: string }[]
  quantity: number
  unitPrice: Money
  subtotal: Money
  discount: Money
  tax: Money
  total: Money
  requiresShipping: boolean
  fulfilledQuantity: number
  refundedQuantity: number
  productId: string | null
  variantId: string | null
}

export interface OrderAddress {
  type: 'shipping' | 'billing'
  firstName: string
  lastName: string
  company: string | null
  line1: string
  line2: string | null
  city: string
  region: string | null
  postalCode: string | null
  countryCode: string
  phone: string | null
}

export interface OrderTotals {
  subtotal: Money
  discountTotal: Money
  taxTotal: Money
  shippingTotal: Money
  paymentFee: Money
  total: Money
  refundedTotal: Money
}

export interface OrderDetail {
  id: string
  orderNumber: string
  customerId: string | null
  email: string
  phone: string | null
  status: OrderStatus
  paymentStatus: PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  displayStatus: string
  currency: string
  totals: OrderTotals
  items: OrderItem[]
  addresses: OrderAddress[]
  discounts: {
    id: string
    discountId: string | null
    code: string
    type: string
    value: number
    amount: Money
  }[]
  shippingMethodId: string | null
  shippingMethodName: string | null
  paymentMethod: string
  customerNote: string | null
  adminNote: string | null
  tags: string[]
  cancelReason: string | null
  source: 'storefront' | 'admin'
  placedAt: string
  confirmedAt: string | null
  cancelledAt: string | null
  completedAt: string | null
  updatedAt: string
}

export interface OrderNote {
  id: string
  body: string
  authorUserId: string | null
  authorName: string | null
  at: string
}

/**
 * One thing that happened, discriminated by `kind`.
 *
 * The server assembles this from the status history, the notes, the payments,
 * the refunds and the shipments; it keeps the discriminator rather than
 * flattening everything into a sentence, so each kind can be rendered on its
 * own terms.
 */
export type TimelineEntry = {
  id: string
  at: string
  actorUserId: string | null
  actorName: string | null
} & (
  | {
      kind: 'status'
      field: 'status' | 'payment_status' | 'fulfillment_status'
      from: string | null
      to: string
      reason: string | null
      note: string | null
    }
  | { kind: 'note'; body: string }
  | { kind: 'payment'; amount: Money; method: string; provider: string; status: string }
  | { kind: 'refund'; amount: Money; reason: string | null; restock: boolean }
  | {
      kind: 'shipment'
      status: string
      carrier: string | null
      trackingNumber: string | null
      itemCount: number
    }
)

export interface OrderPayments {
  payments: {
    id: string
    provider: string
    method: string
    status: string
    amount: Money
    refunded: Money
    capturedAt: string | null
    createdAt: string
  }[]
  refunds: {
    id: string
    paymentId: string
    amount: Money
    reason: string | null
    restock: boolean
    createdAt: string
  }[]
  outstanding: Money
}

export interface Shipment {
  id: string
  orderId: string
  status: string
  carrier: string | null
  service: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  shippedAt: string | null
  deliveredAt: string | null
  createdAt: string
  items: { orderItemId: string; quantity: number }[]
}

export interface OrderListParams extends OffsetQuery {
  q?: string
  status?: OrderStatus
  paymentStatus?: PaymentStatus
  fulfillmentStatus?: FulfillmentStatus
  customerId?: string
  tags?: string[]
  from?: string
  to?: string
}

/** The status moves `transitionSchema` accepts, per machine. */
export const STATUS_TRANSITIONS = {
  status: ['confirmed', 'processing', 'completed', 'cancelled'],
  payment_status: ['authorized', 'paid', 'failed', 'cancelled'],
  fulfillment_status: ['partially_fulfilled', 'fulfilled', 'delivered', 'returned'],
} as const

export type TransitionField = keyof typeof STATUS_TRANSITIONS
