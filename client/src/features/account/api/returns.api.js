import { api } from '@/lib/api'

/**
 * Sending something back.
 *
 * `returnable` is asked of an order rather than assumed from it: how much of a
 * line can still go back depends on what has already been returned, and it is
 * the server that knows. A screen that subtracted its own idea of "returned so
 * far" would offer a quantity the server then refuses.
 *
 * ── Two ways to say who you are ──────────────────────────────────────────────
 *
 * Signed in, the session is the credential and the order is addressed by id.
 * With no account it is the order number and the email it was placed with — the
 * pair the confirmation gave them — and the route is a POST, because an email
 * address in a URL ends up in access logs, browser history and the `Referer` of
 * every asset the page then loads.
 *
 * Passing a `claim` chooses the second. Everything above the API is the same
 * component either way, so a guest and a customer see one return form rather
 * than two that drift apart.
 */
export const returnsApi = {
  list: (params = {}) =>
    api.list('/storefront/returns', { query: { page: params.page, limit: params.limit } }),

  get: (id) => api.get(`/storefront/returns/${id}`),

  returnable: (orderId, claim) =>
    claim
      ? api.post('/storefront/orders/lookup/returnable', claim)
      : api.get(`/storefront/orders/${orderId}/returnable`),

  open: (orderId, body, claim) =>
    claim
      ? api.post('/storefront/orders/lookup/returns', { ...claim, ...body })
      : api.post(`/storefront/orders/${orderId}/returns`, body),
}
