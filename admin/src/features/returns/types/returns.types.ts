import type { Money, OffsetQuery } from '@/types/api'

/**
 * Return shapes, mirrored from `server/src/features/returns/returns.mapper.ts`.
 *
 * A return is **goods coming back**; a refund is money going out. They usually
 * happen together and are recorded apart, because the warehouse records what
 * arrived and in what state, and somebody else decides what to pay back. Every
 * screen here is built on that separation.
 */

export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'declined'
  | 'in_transit'
  | 'received'
  | 'closed'
  | 'cancelled'

export type ReturnReason =
  | 'damaged'
  | 'wrong_item'
  | 'not_as_described'
  | 'no_longer_wanted'
  | 'arrived_late'
  | 'other'

/**
 * The state each unit arrived in.
 *
 * Only `resellable` re-enters sellable stock — the server decides that from the
 * condition, so the admin never sends a restock quantity of its own.
 */
export type ReturnCondition = 'resellable' | 'damaged' | 'opened' | 'missing_parts'

export interface ReturnSummary {
  id: string
  returnNumber: string
  orderId: string
  customerId: string | null
  status: ReturnStatus
  reason: ReturnReason
  refunded: boolean
  requestedAt: string
  closedAt: string | null
}

export interface ReturnLine {
  id: string
  orderItemId: string
  quantity: number
  receivedQuantity: number
  restockedQuantity: number
  condition: ReturnCondition | null
}

export interface ReturnDetail {
  id: string
  returnNumber: string
  order: { id: string; orderNumber: string; email: string; currency: string }
  customerId: string | null
  status: ReturnStatus
  reason: ReturnReason
  customerNote: string | null
  staffNote: string | null
  refundId: string | null
  lines: ReturnLine[]
  requestedAt: string
  approvedAt: string | null
  receivedAt: string | null
  closedAt: string | null
  updatedAt: string
}

export interface ReturnableLine {
  orderItemId: string
  productTitle: string
  variantTitle: string
  sku: string | null
  quantity: number
  returnedQuantity: number
  returnableQuantity: number
}

export interface Returnable {
  orderId: string
  currency: string
  eligible: boolean
  reason: string | null
  lines: ReturnableLine[]
}

/** From `GET /admin/orders/:id/refundable`. Every maximum comes from here. */
export interface RefundableLine {
  orderItemId: string
  productTitle: string
  variantTitle: string
  sku: string | null
  quantity: number
  refundedQuantity: number
  refundableQuantity: number
  perUnit: Money
  lineRefundable: Money
}

export interface Refundable {
  currency: string
  maxRefundable: Money
  shippingTotal: Money
  payments: { id: string; method: string; refundable: Money }[]
  lines: RefundableLine[]
}

export interface ReturnListParams extends OffsetQuery {
  status?: ReturnStatus
  orderId?: string
}

/** The plain lifecycle moves, as their route segments. */
export type ReturnAction = 'approve' | 'decline' | 'in-transit' | 'cancel' | 'close'
