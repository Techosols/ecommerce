import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountApi } from '../api/account.api'

export const accountKeys = {
  orders: (params) => ['account', 'orders', params],
  order: (id) => ['account', 'order', id],
}

export function useMyOrders(params, enabled) {
  return useQuery({
    queryKey: accountKeys.orders(params),
    queryFn: () => accountApi.orders(params),
    enabled,
    placeholderData: (previous) => previous,
  })
}

export function useMyOrder(id, enabled) {
  return useQuery({
    queryKey: accountKeys.order(id),
    queryFn: () => accountApi.order(id),
    enabled: Boolean(id) && enabled,
  })
}

/**
 * A customer cancelling their own order.
 *
 * The server allows it only while the order is still theirs to cancel — before
 * anything has shipped — and always returns the stock. It is not offered on an
 * order past that point, and the server refuses it regardless.
 */
export function useCancelMyOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }) => accountApi.cancelOrder(id, reason),
    onSuccess: (order) => {
      queryClient.setQueryData(accountKeys.order(order.id), order)
      void queryClient.invalidateQueries({ queryKey: ['account', 'orders'] })
    },
  })
}
