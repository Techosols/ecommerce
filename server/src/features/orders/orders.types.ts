/**
 * Order domain types (§5.6).
 *
 * Three orthogonal status machines, not one (decision D-2). Collapsing them
 * makes real states inexpressible — paid but unshipped, shipped but partly
 * refunded — and makes invalid transitions legal.
 */
import type { AddressSnapshot } from '../customers/index.js'

export type { AddressSnapshot }

/**
 * `draft` is an order staff are still building. It is a status rather than a
 * separate table because a draft has the same lines, addresses, discounts and
 * pricing as any other order and becomes real by being placed, not by being
 * copied. Every read path excludes it unless it asks for it by name.
 */
export type OrderStatus =
  | 'draft'
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'completed'
  | 'cancelled'
export type PaymentStatus =
  | 'pending' | 'authorized' | 'paid' | 'partially_refunded' | 'refunded' | 'failed' | 'cancelled'
export type FulfillmentStatus =
  | 'unfulfilled' | 'partially_fulfilled' | 'fulfilled' | 'delivered' | 'returned'

/** The flat vocabulary CLAUDE.md §17 asks for. Derived, never stored. */
export type DisplayStatus =
  | 'pending' | 'confirmed' | 'processing' | 'ready_to_ship' | 'shipped'
  | 'delivered' | 'completed' | 'cancelled' | 'returned'

export interface OrderItem {
  id: string
  orderId: string
  variantId: string | null
  productId: string | null
  productTitle: string
  variantTitle: string
  sku: string | null
  imageUrl: string | null
  options: { name: string; value: string }[]
  unitPriceCents: number
  quantity: number
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
  requiresShipping: boolean
  weightGrams: number
  fulfilledQuantity: number
  refundedQuantity: number
  /** Units committed to a return that has not been declined or cancelled. */
  returnedQuantity: number
}

export interface OrderAddress extends AddressSnapshot {
  id: string
  type: 'shipping' | 'billing'
}

export interface Order {
  id: string
  orderNumber: string
  customerId: string | null
  email: string
  phone: string | null
  status: OrderStatus
  paymentStatus: PaymentStatus
  fulfillmentStatus: FulfillmentStatus
  currency: string
  subtotalCents: number
  discountTotalCents: number
  taxTotalCents: number
  shippingTotalCents: number
  /** Surcharge for the chosen payment method (COD handling, card fee later). */
  paymentFeeCents: number
  totalCents: number
  refundedTotalCents: number
  /**
   * How the customer chose to pay, fixed at checkout.
   *
   * Distinct from `payments.method`, which records how money actually arrived —
   * a COD order has this set from the moment it is placed and no payment row at
   * all until the courier comes back.
   */
  paymentMethod: string
  shippingMethodId: string | null
  shippingMethodName: string | null
  customerNote: string | null
  adminNote: string | null
  cancelReason: string | null
  /** Free-text staff labels, for filtering. Never shown to the customer. */
  tags: string[]
  source: 'storefront' | 'admin'

  // ── Drafts ────────────────────────────────────────────────────────────────
  /** Who is building it. Null on everything that came from the storefront. */
  draftedBy: string | null
  /** The real order a draft became, once it was placed. */
  placedOrderId: string | null
  placedFromDraftAt: Date | null
  /** The code being quoted. Validated afresh by checkout at placement. */
  draftDiscountCode: string | null

  placedAt: Date
  confirmedAt: Date | null
  cancelledAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface OrderDiscount {
  id: string
  orderId: string
  discountId: string | null
  code: string
  type: string
  value: number
  amountCents: number
}

export interface OrderDetail extends Order {
  items: OrderItem[]
  addresses: OrderAddress[]
  discounts: OrderDiscount[]
  displayStatus: DisplayStatus
}

/** One staff observation about an order. Distinct from the pinned admin note. */
export interface OrderNote {
  id: string
  orderId: string
  authorUserId: string | null
  authorName: string | null
  body: string
  createdAt: Date
}

/**
 * One thing that happened to an order, whatever kind of thing it was.
 *
 * The timeline is assembled rather than stored: status changes, notes,
 * payments, refunds and shipments each already have their own table and their
 * own reason to exist, and a second copy of them in an events table would be a
 * second copy to keep true. The union is built at read time, which is the only
 * place it is needed.
 */
export type TimelineEntry = {
  id: string
  at: Date
  actorUserId: string | null
  actorName: string | null
} & (
  | { kind: 'status'; field: string; from: string | null; to: string; reason: string | null; note: string | null }
  | { kind: 'note'; body: string }
  | { kind: 'payment'; amountCents: number; method: string; provider: string; status: string }
  | { kind: 'refund'; amountCents: number; reason: string | null; restock: boolean }
  | { kind: 'shipment'; status: string; carrier: string | null; trackingNumber: string | null; itemCount: number }
)

export interface StatusHistoryEntry {
  id: string
  field: 'status' | 'payment_status' | 'fulfillment_status'
  fromValue: string | null
  toValue: string
  actorUserId: string | null
  actorType: 'customer' | 'staff' | 'system' | 'webhook'
  reason: string | null
  note: string | null
  createdAt: Date
}

export interface CheckoutInput {
  cartId: string
  email: string
  /** Chosen at checkout and re-validated server-side; never trusted as sent. */
  paymentMethod: string
  phone?: string | null
  shippingAddress: AddressSnapshot
  billingAddress?: AddressSnapshot
  shippingMethodId?: string | null
  discountCode?: string | null
  customerNote?: string | null
}

export interface OrderListFilter {
  customerId?: string
  status?: OrderStatus
  paymentStatus?: PaymentStatus
  fulfillmentStatus?: FulfillmentStatus
  query?: string
  /** Orders carrying every one of these tags. */
  tags?: string[]
  from?: string
  to?: string
  limit: number
  offset: number
}
