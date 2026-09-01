import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { orderKeys } from '@/features/orders/hooks/orders.hooks'
import { returnsApi } from '../api/returns.api'
import type {
  ReturnAction,
  ReturnCondition,
  ReturnDetail,
  ReturnListParams,
  ReturnReason,
} from '../types/returns.types'

export const returnKeys = {
  all: ['returns'] as const,
  list: (params: ReturnListParams) => ['returns', 'list', params] as const,
  detail: (id: string) => ['returns', 'detail', id] as const,
  forOrder: (orderId: string) => ['returns', 'order', orderId] as const,
  returnable: (orderId: string) => ['returns', 'returnable', orderId] as const,
  refundable: (orderId: string) => ['returns', 'refundable', orderId] as const,
}

/**
 * A return write touches the order too.
 *
 * Receiving moves stock, refunding moves money and the order's payment status,
 * and both change what is still returnable. Invalidating the order keys as well
 * is what stops the order page showing figures the return has already changed.
 */
function invalidateReturns(queryClient: QueryClient, request?: ReturnDetail) {
  void queryClient.invalidateQueries({ queryKey: returnKeys.all })
  void queryClient.invalidateQueries({ queryKey: orderKeys.all })
  if (request) queryClient.setQueryData(returnKeys.detail(request.id), request)
}

export function useReturns(params: ReturnListParams) {
  return useQuery({
    queryKey: returnKeys.list(params),
    queryFn: () => returnsApi.list(params),
    placeholderData: (previous) => previous,
  })
}

export function useReturn(id: string | undefined) {
  return useQuery({
    queryKey: returnKeys.detail(id ?? 'none'),
    queryFn: () => returnsApi.detail(id!),
    enabled: Boolean(id),
  })
}

/** Returns opened against one order, for the order page. */
export function useOrderReturns(orderId: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: returnKeys.forOrder(orderId ?? 'none'),
    queryFn: () => returnsApi.forOrder(orderId!),
    enabled: Boolean(orderId) && can('returns:read'),
  })
}

export function useReturnable(orderId: string | undefined, enabled = true) {
  const { can } = useAuth()
  return useQuery({
    queryKey: returnKeys.returnable(orderId ?? 'none'),
    queryFn: () => returnsApi.returnable(orderId!),
    enabled: Boolean(orderId) && enabled && can('returns:read'),
  })
}

/** Loaded only when the refund dialog opens — it is a cost per open, not per page. */
export function useRefundable(orderId: string | undefined, enabled: boolean) {
  const { can } = useAuth()
  return useQuery({
    queryKey: returnKeys.refundable(orderId ?? 'none'),
    queryFn: () => returnsApi.refundable(orderId!),
    enabled: Boolean(orderId) && enabled && can('payments:refund'),
  })
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useOpenReturn(orderId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      reason: ReturnReason
      customerNote?: string | null
      lines: { orderItemId: string; quantity: number }[]
    }) => returnsApi.open(orderId, input),
    onSuccess: (request) => invalidateReturns(queryClient, request),
  })
}

export function useMoveReturn(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { action: ReturnAction; staffNote?: string | null }) =>
      returnsApi.move(id, input.action, input.staffNote ?? null),
    onSuccess: (request) => invalidateReturns(queryClient, request),
  })
}

export function useReceiveReturn(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      lines: { orderItemId: string; receivedQuantity: number; condition: ReturnCondition }[]
      staffNote?: string | null
    }) => returnsApi.receive(id, input),
    onSuccess: (request) => invalidateReturns(queryClient, request),
  })
}

export function useRefundReturn(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      paymentId: string
      amountCents: number
      reason?: string | null
      staffNote?: string | null
    }) => returnsApi.refund(id, input),
    onSuccess: (request) => invalidateReturns(queryClient, request),
  })
}
