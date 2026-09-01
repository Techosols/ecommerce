import { api } from '@/lib/api'

/**
 * Sending something back.
 *
 * `returnable` is asked of an order rather than assumed from it: how much of a
 * line can still go back depends on what has already been returned, and it is
 * the server that knows. A screen that subtracted its own idea of "returned so
 * far" would offer a quantity the server then refuses.
 */
export const returnsApi = {
  list: (params = {}) =>
    api.list('/storefront/returns', { query: { page: params.page, limit: params.limit } }),

  get: (id) => api.get(`/storefront/returns/${id}`),

  returnable: (orderId) => api.get(`/storefront/orders/${orderId}/returnable`),

  open: (orderId, body) => api.post(`/storefront/orders/${orderId}/returns`, body),
}
