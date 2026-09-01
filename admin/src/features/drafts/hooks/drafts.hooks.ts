import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/useAuth'
import { orderKeys } from '@/features/orders/hooks/orders.hooks'
import { draftsApi } from '../api/drafts.api'
import type { DraftDetail, DraftLineInput, DraftListParams, DraftPatch } from '../types/drafts.types'

export const draftKeys = {
  all: ['drafts'] as const,
  list: (params: DraftListParams) => ['drafts', 'list', params] as const,
  detail: (id: string) => ['drafts', 'detail', id] as const,
  variants: (q: string) => ['drafts', 'variants', q] as const,
}

export function useDrafts(params: DraftListParams) {
  const { can } = useAuth()
  return useQuery({
    queryKey: draftKeys.list(params),
    queryFn: () => draftsApi.list(params),
    enabled: can('orders:read'),
    placeholderData: (previous) => previous,
  })
}

export function useDraft(id: string | undefined) {
  const { can } = useAuth()
  return useQuery({
    queryKey: draftKeys.detail(id ?? 'none'),
    queryFn: () => draftsApi.get(id!),
    enabled: Boolean(id) && can('orders:read'),
  })
}

/**
 * Products to put on a draft.
 *
 * Only asked once there is something to search for: an empty term would list
 * the catalogue in no useful order, and the server requires one anyway.
 */
export function useVariantSearch(term: string) {
  const { can } = useAuth()
  return useQuery({
    queryKey: draftKeys.variants(term),
    queryFn: () => draftsApi.variantSearch(term),
    enabled: term.trim().length > 0 && can('orders:read'),
    placeholderData: (previous) => previous,
  })
}

export function useCreateDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { email?: string; customerId?: string | null }) => draftsApi.create(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: draftKeys.all }),
  })
}

/**
 * Writes an edit and adopts the re-quoted draft that comes back.
 *
 * The response *is* the new state — the server re-prices after every change —
 * so it is written straight into the cache rather than triggering a refetch
 * that would ask the same question again and flicker the totals in between.
 */
function useDraftWrite<TInput>(
  id: string,
  mutationFn: (input: TInput) => Promise<DraftDetail>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (draft) => {
      queryClient.setQueryData(draftKeys.detail(id), draft)
      void queryClient.invalidateQueries({ queryKey: ['drafts', 'list'] })
    },
  })
}

export function useSetDraftLines(id: string) {
  return useDraftWrite<DraftLineInput[]>(id, (lines) => draftsApi.setLines(id, lines))
}

export function useUpdateDraft(id: string) {
  return useDraftWrite<DraftPatch>(id, (patch) => draftsApi.update(id, patch))
}

/**
 * Places the draft, producing a real order.
 *
 * The idempotency key is minted per attempt rather than per click, so a retry
 * after a network failure replays the same placement instead of making a
 * second one. Orders and drafts are both invalidated: one has gained a row,
 * the other has gained a pointer to it.
 */
export function usePlaceDraft(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => draftsApi.place(id, crypto.randomUUID()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: draftKeys.all })
      void queryClient.invalidateQueries({ queryKey: orderKeys.all })
    },
  })
}

export function useDiscardDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => draftsApi.discard(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: draftKeys.all }),
  })
}
