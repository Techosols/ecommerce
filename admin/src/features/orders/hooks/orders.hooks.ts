import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { ordersApi } from '../api/orders.api'
import type { OrderDetail, OrderListParams, TransitionField } from '../types/orders.types'

export const orderKeys = {
  all: ['orders'] as const,
  lists: () => ['orders', 'list'] as const,
  list: (params: OrderListParams) => ['orders', 'list', params] as const,
  detail: (id: string) => ['orders', 'detail', id] as const,
  timeline: (id: string) => ['orders', 'timeline', id] as const,
  notes: (id: string) => ['orders', 'notes', id] as const,
  payments: (id: string) => ['orders', 'payments', id] as const,
  shipments: (id: string) => ['orders', 'shipments', id] as const,
}

/**
 * After a write, the order and everything derived from it are suspect.
 *
 * A confirmation moves stock, writes a status row and can settle a payment;
 * a shipment changes the fulfilment status. Reasoning about which of the five
 * cached keys each of those touches is how a cache drifts from the server, so
 * the whole `orders` key goes and the response seeds the detail it lands on.
 */
function invalidateOrders(queryClient: QueryClient, order?: OrderDetail) {
  void queryClient.invalidateQueries({ queryKey: orderKeys.all })
  if (order) queryClient.setQueryData(orderKeys.detail(order.id), order)
  // The sidebar badge counts orders awaiting action.
  void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
}

export function useOrders(params: OrderListParams) {
  return useQuery({
    queryKey: orderKeys.list(params),
    queryFn: () => ordersApi.list(params),
    // Keeps the current page on screen while the next one loads, so paging and
    // typing in the search box do not flash an empty table.
    placeholderData: (previous) => previous,
  })
}

export function useOrder(id: string | undefined) {
  return useQuery({
    queryKey: orderKeys.detail(id ?? 'none'),
    queryFn: () => ordersApi.detail(id!),
    enabled: Boolean(id),
  })
}

export function useOrderTimeline(id: string | undefined) {
  return useQuery({
    queryKey: orderKeys.timeline(id ?? 'none'),
    queryFn: () => ordersApi.timeline(id!),
    enabled: Boolean(id),
  })
}

/** Payments and refunds, behind `payments:read`. Skipped without it. */
export function useOrderPayments(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: orderKeys.payments(id ?? 'none'),
    queryFn: () => ordersApi.payments(id!),
    enabled: Boolean(id) && can('payments:read'),
  })
}

/** Shipments, behind `shipping:read`. */
export function useOrderShipments(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: orderKeys.shipments(id ?? 'none'),
    queryFn: () => ordersApi.shipments(id!),
    enabled: Boolean(id) && can('shipping:read'),
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useAddOrderNote(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => ordersApi.addNote(id, body),
    // Only the note and timeline keys: a note changes nothing about the order
    // itself, and refetching the order would discard an unsaved tag edit.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orderKeys.notes(id) })
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(id) })
    },
  })
}

export function useDeleteOrderNote(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => ordersApi.deleteNote(id, noteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orderKeys.notes(id) })
      void queryClient.invalidateQueries({ queryKey: orderKeys.timeline(id) })
    },
  })
}

export function useAnnotateOrder(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: { note?: string | null; tags?: string[] }) => ordersApi.annotate(id, patch),
    onSuccess: (order) => invalidateOrders(queryClient, order),
  })
}

export type OrderAction =
  | { kind: 'confirm' }
  | { kind: 'cancel'; reason?: string | null; restock?: boolean }
  | { kind: 'transition'; field: TransitionField; to: string; reason?: string | null }

/**
 * The lifecycle moves, as one mutation keyed by the action.
 *
 * They share a shape — an order id in, the fresh order out — so the toast, the
 * error handling and the invalidation are written once rather than five times.
 */
export function useOrderAction(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (action: OrderAction) => {
      if (action.kind === 'confirm') return ordersApi.confirm(id)
      if (action.kind === 'cancel') {
        return ordersApi.cancel(id, {
          ...(action.reason === undefined ? {} : { reason: action.reason }),
          ...(action.restock === undefined ? {} : { restock: action.restock }),
        })
      }
      return ordersApi.transition(id, action.field, action.to, {
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      })
    },
    onSuccess: (order) => invalidateOrders(queryClient, order),
  })
}

export function useRecordPayment(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { method?: string; key?: string }) =>
      ordersApi.recordPayment(id, input.method ? { method: input.method } : {}, input.key),
    // The response is a payment, not an order, so the order has to be refetched
    // rather than written: recording money can settle the payment status.
    onSuccess: () => invalidateOrders(queryClient),
  })
}

/**
 * Issuing a refund.
 *
 * Idempotent by key, because a retried click must send the money once. The
 * whole `orders` key goes afterwards: a refund changes the payment status, the
 * refunded total and what is still refundable.
 */
export function useRefundOrder(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      paymentId: string
      amountCents: number
      reason?: string | null
      restock?: boolean
      items?: { orderItemId: string; quantity: number }[]
    }) => ordersApi.refund(id, input, crypto.randomUUID()),
    onSuccess: () => invalidateOrders(queryClient),
  })
}

export function useCreateShipment(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      items: { orderItemId: string; quantity: number }[]
      carrier?: string | null
      trackingNumber?: string | null
    }) =>
      ordersApi.createShipment(id, {
        items: input.items,
        ...(input.carrier === undefined ? {} : { carrier: input.carrier }),
        ...(input.trackingNumber === undefined ? {} : { trackingNumber: input.trackingNumber }),
      }),
    onSuccess: () => invalidateOrders(queryClient),
  })
}
