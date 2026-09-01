import { api } from '@/lib/api'

/**
 * Signing in, and a customer's own orders.
 *
 * The access token lives in memory and the refresh token is an httpOnly cookie
 * the browser cannot read — so `login` returns a token the caller hands to
 * `tokens.set`, and everything after that is the API client's business.
 *
 * A guest can buy but cannot list orders: there is no verified identity to
 * list them for. That is why `orders` needs a session and `lookup` — on the
 * checkout API — does not.
 */
export const accountApi = {
  login: (email, password) =>
    api.post('/auth/login', { email, password }, { skipAuthRefresh: true }),

  register: (body) => api.post('/auth/register', body, { skipAuthRefresh: true }),

  me: () => api.get('/auth/me'),

  logout: () => api.post('/auth/logout', {}, { skipAuthRefresh: true }),

  orders: (params = {}) =>
    api.list('/storefront/orders', { query: { page: params.page, limit: params.limit } }),

  order: (id) => api.get(`/storefront/orders/${id}`),

  cancelOrder: (id, reason) =>
    api.post(`/storefront/orders/${id}/cancel`, { reason: reason ?? null }),
}
