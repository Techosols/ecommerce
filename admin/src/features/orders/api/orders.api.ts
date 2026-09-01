import { api } from '@/lib/api/client'
import type { Money } from '@/types/api'
import type {
  OrderDetail,
  OrderListParams,
  OrderNote,
  OrderPayments,
  OrderSummary,
  Shipment,
  TimelineEntry,
  TransitionField,
} from '../types/orders.types'

/**
 * The order endpoints, exactly as `orders.admin.routes.ts` publishes them.
 *
 * Note what is absent, because the server does not offer it and inventing it
 * would be inventing an endpoint:
 *
 *   • no `PATCH /orders/:id` — an order's money is fixed at checkout, and its
 *     statuses move through named transitions that record who moved them
 *   • no delete — an order is a financial record
 *   • no way to set a line price, a total or a tax figure from the client
 *
 * Five permissions guard these, because they are five different decisions:
 * `orders:read`, `orders:write`, `orders:cancel`, `payments:capture` and
 * `payments:refund`.
 */
export const ordersApi = {
  list: (params: OrderListParams) =>
    api.list<OrderSummary>('/admin/orders', {
      query: {
        page: params.page,
        limit: params.limit,
        q: params.q,
        status: params.status,
        paymentStatus: params.paymentStatus,
        fulfillmentStatus: params.fulfillmentStatus,
        customerId: params.customerId,
        tags: params.tags,
        from: params.from,
        to: params.to,
      },
    }),

  detail: (id: string) => api.get<OrderDetail>(`/admin/orders/${id}`),

  /** Status changes, notes, payments, refunds and shipments in one feed. */
  timeline: (id: string) => api.get<TimelineEntry[]>(`/admin/orders/${id}/timeline`),

  // ── Staff notes ───────────────────────────────────────────────────────────

  notes: (id: string) => api.get<OrderNote[]>(`/admin/orders/${id}/notes`),

  /** Appended, never edited — which is why there is no update call here. */
  addNote: (id: string, body: string) =>
    api.post<OrderNote>(`/admin/orders/${id}/notes`, { body }),

  deleteNote: (id: string, noteId: string) =>
    api.delete<void>(`/admin/orders/${id}/notes/${noteId}`),

  /** The pinned note and the tags travel together, because they are one edit. */
  annotate: (id: string, patch: { note?: string | null; tags?: string[] }) =>
    api.patch<OrderDetail>(`/admin/orders/${id}/annotations`, patch),

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * One named move on one machine.
   *
   * `confirmed` and `cancelled` on the lifecycle machine are routed by the
   * server to `confirm()` and `cancel()`, because both move stock as well as
   * status — the admin does not have to know that, and must not duplicate it.
   */
  transition: (
    id: string,
    field: TransitionField,
    to: string,
    extras: { reason?: string | null; note?: string | null } = {},
  ) => api.post<OrderDetail>(`/admin/orders/${id}/transitions`, { field, to, ...extras }),

  confirm: (id: string) => api.post<OrderDetail>(`/admin/orders/${id}/confirm`),

  cancel: (id: string, body: { reason?: string | null; restock?: boolean } = {}) =>
    api.post<OrderDetail>(`/admin/orders/${id}/cancel`, body),

  // ── Money ─────────────────────────────────────────────────────────────────

  payments: (id: string) => api.get<OrderPayments>(`/admin/orders/${id}/payments`),

  /**
   * Records money received. No amount by default — the server computes what is
   * outstanding, and an idempotency key makes a retried click one payment.
   */
  recordPayment: (id: string, body: { method?: string; amountCents?: number } = {}, key?: string) =>
    api.post<{ id: string; status: string }>(`/admin/orders/${id}/payments`, body, {
      ...(key ? { idempotencyKey: key } : {}),
    }),

  /**
   * Sends money back.
   *
   * `restock` is a separate decision from the refund and defaults to off at the
   * call site: a refund is money, and putting goods back on the shelf is stock.
   * The units are sent either way, because `refunded_quantity` is what stops
   * the same ones being refunded twice.
   */
  refund: (
    id: string,
    body: {
      paymentId: string
      amountCents: number
      reason?: string | null
      restock?: boolean
      items?: { orderItemId: string; quantity: number }[]
    },
    key?: string,
  ) =>
    api.post<{ id: string; amount: Money; reason: string | null; restock: boolean }>(
      `/admin/orders/${id}/refunds`,
      body,
      { ...(key ? { idempotencyKey: key } : {}) },
    ),

  // ── Shipments ─────────────────────────────────────────────────────────────

  shipments: (id: string) => api.get<Shipment[]>(`/admin/orders/${id}/shipments`),

  createShipment: (
    id: string,
    body: {
      items: { orderItemId: string; quantity: number }[]
      carrier?: string | null
      service?: string | null
      trackingNumber?: string | null
      trackingUrl?: string | null
    },
  ) => api.post<Shipment>(`/admin/orders/${id}/shipments`, body),

  setShipmentStatus: (shipmentId: string, status: string) =>
    api.post<Shipment>(`/admin/shipments/${shipmentId}/status`, { status }),
}
