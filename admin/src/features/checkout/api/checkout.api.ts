import { api } from '@/lib/api/client'
import type {
  AttemptListParams,
  AttemptSummary,
  CartDetail,
  CartListParams,
  CartSummary,
  CheckoutAttempt,
  RecoveryResult,
} from '../types/checkout.types'

/**
 * Sales that did not complete.
 *
 * `orders:read` covers looking at both — a basket and a failed checkout are
 * both orders that did not happen, and the people who work the order queue are
 * the ones who chase them. Emailing somebody needs `customers:write`, because
 * that is the permission that governs contacting a customer.
 *
 * Notice what is absent: nothing writes to a cart. Editing a shopper's basket
 * behind their back is not something a shop should be able to do, and the
 * server publishes no route that would.
 */
export const checkoutApi = {
  carts: (params: CartListParams) =>
    api.list<CartSummary>('/admin/carts', {
      query: {
        page: params.page,
        limit: params.limit,
        status: params.status,
        q: params.q,
        withItemsOnly: params.withItemsOnly,
      },
    }),

  cart: (id: string) => api.get<CartDetail>(`/admin/carts/${id}`),

  /** Queued, never sent inline, and refused for a guest with no address. */
  recover: (id: string) => api.post<RecoveryResult>(`/admin/carts/${id}/recover`),

  attempts: (params: AttemptListParams) =>
    api.list<CheckoutAttempt>('/admin/checkout-attempts', {
      query: {
        page: params.page,
        limit: params.limit,
        outcome: params.outcome,
        failureCode: params.failureCode,
        from: params.from,
        to: params.to,
      },
    }),

  /**
   * The rate and the reasons over a window, computed by the server.
   *
   * Separate from the list because "17% of checkouts failed" is a different
   * question from "show me the last twenty", and counting a page to answer it
   * would make the figure depend on the pager.
   */
  attemptSummary: (params: { from?: string; to?: string } = {}) =>
    api.get<AttemptSummary>('/admin/checkout-attempts/summary', {
      query: { from: params.from, to: params.to },
    }),
}
