/**
 * Return shapes (§5.6).
 *
 * A return is goods coming back, which is a different event from a refund —
 * money going out. They usually happen together and are still recorded apart,
 * because the warehouse records what arrived and in what state, and somebody
 * else decides what to pay back.
 */

export const RETURN_STATUSES = [
  'requested',
  'approved',
  'declined',
  'in_transit',
  'received',
  'closed',
  'cancelled',
] as const

export type ReturnStatus = (typeof RETURN_STATUSES)[number]

export const RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'not_as_described',
  'no_longer_wanted',
  'arrived_late',
  'other',
] as const

export type ReturnReason = (typeof RETURN_REASONS)[number]

/**
 * The state each unit arrived in.
 *
 * Only `resellable` re-enters sellable stock. The other three are written off,
 * and they are kept apart rather than collapsed into "not resellable" because a
 * shop that sees `damaged` climbing on one product has a packaging problem,
 * and one that sees `wrong_item` has a picking problem.
 */
export const RETURN_CONDITIONS = ['resellable', 'damaged', 'opened', 'missing_parts'] as const

export type ReturnCondition = (typeof RETURN_CONDITIONS)[number]

export interface ReturnLineItem {
  id: string
  returnId: string
  orderItemId: string
  quantity: number
  receivedQuantity: number
  restockedQuantity: number
  condition: ReturnCondition | null
  createdAt: Date
}

export interface ReturnRequest {
  id: string
  returnNumber: string
  orderId: string
  customerId: string | null
  status: ReturnStatus
  reason: ReturnReason
  customerNote: string | null
  staffNote: string | null
  refundId: string | null
  requestedAt: Date
  approvedAt: Date | null
  receivedAt: Date | null
  closedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ReturnDetail extends ReturnRequest {
  lines: ReturnLineItem[]
  /** Enough of the order to render the return without a second request. */
  order: {
    id: string
    orderNumber: string
    email: string
    currency: string
  }
}

export interface ReturnListFilter {
  status?: ReturnStatus
  orderId?: string
  customerId?: string
  limit: number
  offset: number
}
