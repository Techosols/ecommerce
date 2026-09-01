import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { checkoutApi } from '../api/checkout.api'
import type { AttemptListParams, CartListParams } from '../types/checkout.types'

export const checkoutKeys = {
  all: ['checkout'] as const,
  carts: (params: CartListParams) => ['checkout', 'carts', params] as const,
  cart: (id: string) => ['checkout', 'cart', id] as const,
  attempts: (params: AttemptListParams) => ['checkout', 'attempts', params] as const,
  attemptSummary: (params: { from?: string; to?: string }) =>
    ['checkout', 'attempt-summary', params] as const,
}

export function useCarts(params: CartListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: checkoutKeys.carts(params),
    queryFn: () => checkoutApi.carts(params),
    enabled: can('orders:read'),
    placeholderData: (previous) => previous,
  })
}

export function useCart(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: checkoutKeys.cart(id ?? 'none'),
    queryFn: () => checkoutApi.cart(id!),
    enabled: Boolean(id) && can('orders:read'),
  })
}

/**
 * Sends the shopper back to their basket.
 *
 * Nothing is invalidated on success: the cart is unchanged by being emailed
 * about, and refetching the list would only make the screen flicker.
 */
export function useRecoverCart() {
  return useMutation({ mutationFn: (id: string) => checkoutApi.recover(id) })
}

export function useCheckoutAttempts(params: AttemptListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: checkoutKeys.attempts(params),
    queryFn: () => checkoutApi.attempts(params),
    enabled: can('orders:read'),
    placeholderData: (previous) => previous,
  })
}

export function useAttemptSummary(params: { from?: string; to?: string } = {}) {
  const { can } = useAuth()
  return useQuery({
    queryKey: checkoutKeys.attemptSummary(params),
    queryFn: () => checkoutApi.attemptSummary(params),
    enabled: can('orders:read'),
  })
}

/** Kept for symmetry with the other features; nothing yet writes to a cart. */
export function useInvalidateCheckout() {
  const queryClient = useQueryClient()
  return () => void queryClient.invalidateQueries({ queryKey: checkoutKeys.all })
}
