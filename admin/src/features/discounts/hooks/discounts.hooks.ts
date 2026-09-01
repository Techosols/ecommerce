import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { discountsApi } from '../api/discounts.api'
import type {
  CreateDiscountInput,
  DiscountListParams,
  UpdateDiscountInput,
} from '../types/discounts.types'

export const discountKeys = {
  all: ['discounts'] as const,
  list: (params: DiscountListParams) => ['discounts', 'list', params] as const,
  detail: (id: string) => ['discounts', 'detail', id] as const,
  redemptions: (id: string, page: number) => ['discounts', 'redemptions', id, page] as const,
}

function invalidate(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: discountKeys.all })
}

export function useDiscounts(params: DiscountListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: discountKeys.list(params),
    queryFn: () => discountsApi.list(params),
    enabled: can('discounts:read'),
    placeholderData: (previous) => previous,
  })
}

export function useDiscount(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: discountKeys.detail(id ?? 'none'),
    queryFn: () => discountsApi.get(id!),
    enabled: Boolean(id) && can('discounts:read'),
  })
}

/**
 * The ledger. Paged, because a successful campaign has thousands of rows and
 * the interesting ones are the newest.
 */
export function useRedemptions(id: string | undefined, page: number) {
  const { can } = useAuth()
  return useQuery({
    queryKey: discountKeys.redemptions(id ?? 'none', page),
    queryFn: () => discountsApi.redemptions(id!, { page, limit: 20 }),
    enabled: Boolean(id) && can('discounts:read'),
    placeholderData: (previous) => previous,
  })
}

export function useCreateDiscount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateDiscountInput) => discountsApi.create(input),
    onSuccess: () => invalidate(queryClient),
  })
}

export function useUpdateDiscount(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateDiscountInput) => discountsApi.update(id, patch),
    onSuccess: (discount) => {
      queryClient.setQueryData(discountKeys.detail(id), discount)
      void queryClient.invalidateQueries({ queryKey: ['discounts', 'list'] })
    },
  })
}

export function useArchiveDiscount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => discountsApi.archive(id),
    onSuccess: () => invalidate(queryClient),
  })
}
