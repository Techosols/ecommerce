import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { returnsApi } from '../api/returns.api'

export const returnKeys = {
  list: (params) => ['account', 'returns', params],
  detail: (id) => ['account', 'return', id],
  returnable: (orderId) => ['account', 'returnable', orderId],
}

export function useMyReturns(params, enabled) {
  return useQuery({
    queryKey: returnKeys.list(params),
    queryFn: () => returnsApi.list(params),
    enabled,
    placeholderData: (previous) => previous,
  })
}

export function useReturnable(orderId, enabled) {
  return useQuery({
    queryKey: returnKeys.returnable(orderId),
    queryFn: () => returnsApi.returnable(orderId),
    enabled: Boolean(orderId) && enabled,
    // What can still go back changes the moment a return is opened, so this is
    // never served from cache.
    staleTime: 0,
  })
}

export function useOpenReturn(orderId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body) => returnsApi.open(orderId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['account', 'returns'] })
      void queryClient.invalidateQueries({ queryKey: returnKeys.returnable(orderId) })
    },
  })
}
