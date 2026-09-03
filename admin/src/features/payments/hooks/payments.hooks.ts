import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { orderKeys } from '@/features/orders/hooks/orders.hooks'
import { paymentsApi } from '../api/payments.api'
import type { PaymentListParams, ProofListParams } from '../types/payments.types'

export const paymentKeys = {
  all: ['payments'] as const,
  list: (params: PaymentListParams) => ['payments', 'list', params] as const,
  proofs: (params: ProofListParams) => ['payments', 'proofs', params] as const,
  proof: (id: string) => ['payments', 'proof', id] as const,
  forOrder: (orderId: string) => ['payments', 'order', orderId] as const,
}

/**
 * Deciding a receipt changes the order too.
 *
 * Approving records a payment, marks the order paid and confirms it. A screen
 * still showing that order as awaiting payment would be showing something the
 * click has already made untrue, so the order keys go with it.
 */
function invalidatePayments(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: paymentKeys.all })
  void queryClient.invalidateQueries({ queryKey: orderKeys.all })
}

export function usePayments(params: PaymentListParams) {
  return useQuery({
    queryKey: paymentKeys.list(params),
    queryFn: () => paymentsApi.list(params),
    placeholderData: (previous) => previous,
  })
}

export function usePaymentProofs(params: ProofListParams) {
  return useQuery({
    queryKey: paymentKeys.proofs(params),
    queryFn: () => paymentsApi.proofs(params),
    placeholderData: (previous) => previous,
  })
}

/**
 * How many receipts are waiting, for the sidebar badge.
 *
 * Asks for a single row: the count comes from `meta.pending`, which the server
 * computes over the whole table, so fetching a page of fifty to count them
 * would be fifty rows of screenshots nobody renders. Gated on the permission,
 * because the shell mounts for every signed-in user and a warehouse account
 * without `payments:read` should not be firing a request that only ever 403s.
 */
export function usePendingProofCount(): number | undefined {
  const { can } = useAuth()
  const query = useQuery({
    queryKey: paymentKeys.proofs({ page: 1, limit: 1, status: 'submitted' }),
    queryFn: () => paymentsApi.proofs({ page: 1, limit: 1, status: 'submitted' }),
    enabled: can('payments:read'),
  })
  const pending = query.data?.meta?.pending
  return typeof pending === 'number' ? pending : undefined
}

/** Receipts against one order, for the order page. Gated so a reader without */
/** `payments:read` does not fire a request that will only 403. */
export function useOrderPaymentProofs(orderId: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: paymentKeys.forOrder(orderId ?? 'none'),
    queryFn: () => paymentsApi.forOrder(orderId!),
    enabled: Boolean(orderId) && can('payments:read'),
  })
}

export function useApproveProof() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => paymentsApi.approve(id),
    onSuccess: () => invalidatePayments(queryClient),
  })
}

export function useRejectProof() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => paymentsApi.reject(id, note),
    onSuccess: () => invalidatePayments(queryClient),
  })
}
