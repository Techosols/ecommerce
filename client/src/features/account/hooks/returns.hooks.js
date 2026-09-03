import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { returnsApi } from '../api/returns.api'

export const returnKeys = {
  list: (params) => ['account', 'returns', params],
  detail: (id) => ['account', 'return', id],
  returnable: (orderId, claim) => ['account', 'returnable', orderId ?? claim?.orderNumber],
}

export function useMyReturns(params, enabled) {
  return useQuery({
    queryKey: returnKeys.list(params),
    queryFn: () => returnsApi.list(params),
    enabled,
    placeholderData: (previous) => previous,
  })
}

/**
 * What can still go back.
 *
 * `claim` is the guest's order number and email; without it the signed-in
 * routes are used. One hook rather than two, so the return form is the same
 * component for both and cannot drift.
 */
export function useReturnable(orderId, enabled, claim) {
  return useQuery({
    queryKey: returnKeys.returnable(orderId, claim),
    queryFn: () => returnsApi.returnable(orderId, claim),
    enabled: Boolean(orderId ?? claim?.orderNumber) && enabled !== false,
    // What can still go back changes the moment a return is opened, so this is
    // never served from cache.
    staleTime: 0,
  })
}

export function useOpenReturn(orderId, claim) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body) => returnsApi.open(orderId, body, claim),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['account', 'returns'] })
      void queryClient.invalidateQueries({ queryKey: returnKeys.returnable(orderId, claim) })
    },
  })
}
