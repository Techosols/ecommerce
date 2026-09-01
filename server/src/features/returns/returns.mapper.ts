/**
 * Return serialisation (§7.5).
 *
 * One admin serialiser and one customer serialiser, written apart. The customer
 * sees what they sent back and where it has got to; the staff note, who
 * approved it and the refund id are operational and stay inside.
 */
import type { ReturnDetail, ReturnRequest } from './returns.types.js'

export function returnCardDto(request: ReturnRequest) {
  return {
    id: request.id,
    returnNumber: request.returnNumber,
    orderId: request.orderId,
    customerId: request.customerId,
    status: request.status,
    reason: request.reason,
    refunded: request.refundId !== null,
    requestedAt: request.requestedAt.toISOString(),
    closedAt: request.closedAt?.toISOString() ?? null,
  }
}

export function adminReturnDto(request: ReturnDetail) {
  return {
    id: request.id,
    returnNumber: request.returnNumber,
    order: request.order,
    customerId: request.customerId,
    status: request.status,
    reason: request.reason,
    customerNote: request.customerNote,
    staffNote: request.staffNote,
    refundId: request.refundId,
    lines: request.lines.map((line) => ({
      id: line.id,
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      restockedQuantity: line.restockedQuantity,
      condition: line.condition,
    })),
    requestedAt: request.requestedAt.toISOString(),
    approvedAt: request.approvedAt?.toISOString() ?? null,
    receivedAt: request.receivedAt?.toISOString() ?? null,
    closedAt: request.closedAt?.toISOString() ?? null,
    updatedAt: request.updatedAt.toISOString(),
  }
}

/** The customer's own return. No staff note, no refund id, no restock detail. */
export function customerReturnDto(request: ReturnDetail) {
  return {
    id: request.id,
    returnNumber: request.returnNumber,
    orderNumber: request.order.orderNumber,
    status: request.status,
    reason: request.reason,
    customerNote: request.customerNote,
    lines: request.lines.map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
    })),
    requestedAt: request.requestedAt.toISOString(),
    closedAt: request.closedAt?.toISOString() ?? null,
  }
}
