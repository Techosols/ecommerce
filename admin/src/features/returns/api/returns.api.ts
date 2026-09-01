import { api } from '@/lib/api/client'
import type {
  Refundable,
  Returnable,
  ReturnAction,
  ReturnCondition,
  ReturnDetail,
  ReturnListParams,
  ReturnReason,
  ReturnSummary,
} from '../types/returns.types'

/**
 * The returns endpoints, exactly as `returns.admin.routes.ts` publishes them.
 *
 * The lifecycle is one endpoint per move rather than a `PATCH` carrying a
 * status, so there is nothing here that could set a return to `closed` when
 * nothing ever arrived for it.
 *
 * Receiving deliberately sends a quantity and a **condition** and no restock
 * figure: the server decides what goes back on the shelf, and a client that
 * could send both could ask it to restock damaged goods.
 */
export const returnsApi = {
  list: (params: ReturnListParams) =>
    api.list<ReturnSummary>('/admin/returns', {
      query: {
        page: params.page,
        limit: params.limit,
        status: params.status,
        orderId: params.orderId,
      },
    }),

  detail: (id: string) => api.get<ReturnDetail>(`/admin/returns/${id}`),

  /** What can still be sent back on an order. */
  returnable: (orderId: string) => api.get<Returnable>(`/admin/orders/${orderId}/returnable`),

  /** Every return opened against one order. */
  forOrder: (orderId: string) => api.get<ReturnSummary[]>(`/admin/orders/${orderId}/returns`),

  open: (
    orderId: string,
    body: {
      reason: ReturnReason
      customerNote?: string | null
      lines: { orderItemId: string; quantity: number }[]
    },
  ) => api.post<ReturnDetail>(`/admin/orders/${orderId}/returns`, body),

  /** approve · decline · in-transit · cancel · close */
  move: (id: string, action: ReturnAction, staffNote?: string | null) =>
    api.post<ReturnDetail>(`/admin/returns/${id}/${action}`, staffNote ? { staffNote } : {}),

  receive: (
    id: string,
    body: {
      lines: { orderItemId: string; receivedQuantity: number; condition: ReturnCondition }[]
      staffNote?: string | null
    },
  ) => api.post<ReturnDetail>(`/admin/returns/${id}/receive`, body),

  /** Needs `returns:write` *and* `payments:refund` — two approvals, one route. */
  refund: (
    id: string,
    body: { paymentId: string; amountCents: number; reason?: string | null; staffNote?: string | null },
  ) => api.post<ReturnDetail>(`/admin/returns/${id}/refund`, body),

  /** The three limits the refund endpoint enforces, so the dialog can respect them. */
  refundable: (orderId: string) => api.get<Refundable>(`/admin/orders/${orderId}/refundable`),
}
