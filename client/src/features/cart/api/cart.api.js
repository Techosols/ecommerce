import { api } from '@/lib/api'

/**
 * The basket.
 *
 * There is one route shape — `/cart` — and never `/carts/:id`. The caller is
 * identified by their session or by an httpOnly guest cookie, so a cart id in
 * a URL is not a way to reach somebody else's basket. That is also why nothing
 * here takes an id: there is only ever *your* cart.
 *
 * Every call returns the whole cart, re-priced against the live catalogue. The
 * storefront never patches its own copy after a change — it adopts what came
 * back, because the server has just recomputed availability and totals and the
 * browser has not.
 */
export const cartApi = {
  get: () => api.get('/storefront/cart'),

  add: (variantId, quantity = 1) =>
    api.post('/storefront/cart/items', { variantId, quantity }),

  /** Quantity 0 is how a line is removed by the same control that sets it. */
  setQuantity: (variantId, quantity) =>
    api.patch(`/storefront/cart/items/${variantId}`, { quantity }),

  remove: (variantId) => api.delete(`/storefront/cart/items/${variantId}`),

  clear: () => api.delete('/storefront/cart'),
}
