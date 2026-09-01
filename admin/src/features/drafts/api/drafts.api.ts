import { api } from '@/lib/api/client'
import type {
  DraftDetail,
  DraftLineInput,
  DraftListParams,
  DraftPatch,
  DraftSummary,
  VariantMatch,
} from '../types/drafts.types'
import type { OrderDetail } from '@/features/orders/types/orders.types'

/**
 * Orders built by hand.
 *
 * `orders:read` to look, `orders:write` to build — a draft becomes a real
 * sale, so making one is the same authority as changing an order.
 *
 * Two things about the shape of this surface are deliberate:
 *
 *   **Lines are sent whole.** `setLines` replaces the list rather than adding
 *   or removing one at a time. The screen holds the list; a diff computed here
 *   against a copy that has gone stale is how a line quietly disappears.
 *
 *   **Every write returns the re-quoted draft.** The server re-prices after
 *   each change, so the caller never has to work out what the edit did to the
 *   total — it is told.
 */
export const draftsApi = {
  list: (params: DraftListParams) =>
    api.list<DraftSummary>('/admin/drafts', {
      query: { page: params.page, limit: params.limit, q: params.q },
    }),

  get: (id: string) => api.get<DraftDetail>(`/admin/drafts/${id}`),

  create: (body: { customerId?: string | null; email?: string; customerNote?: string | null }) =>
    api.post<DraftSummary>('/admin/drafts', body),

  setLines: (id: string, lines: DraftLineInput[]) =>
    api.put<DraftDetail>(`/admin/drafts/${id}/lines`, { lines }),

  update: (id: string, patch: DraftPatch) => api.patch<DraftDetail>(`/admin/drafts/${id}`, patch),

  /**
   * Runs the ordinary checkout over the draft's lines.
   *
   * Idempotent for the same reason storefront checkout is: a double-clicked
   * button must not reserve the stock twice or bill the customer twice.
   */
  place: (id: string, idempotencyKey: string) =>
    api.post<OrderDetail>(`/admin/drafts/${id}/place`, undefined, { idempotencyKey }),

  discard: (id: string) => api.delete<void>(`/admin/drafts/${id}`),

  variantSearch: (q: string) =>
    api.get<VariantMatch[]>('/admin/drafts/variant-search', { query: { q, limit: 20 } }),
}
