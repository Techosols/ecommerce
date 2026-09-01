import { api } from '@/lib/api'

/**
 * A customer's own profile and address book.
 *
 * Every route here is scoped to the session — there is no `/customers/:id` on
 * this surface at all, so a request cannot name somebody else's address book
 * even in principle. That is the server's design, and the client simply has no
 * id to send.
 *
 * ── What the server will not accept ─────────────────────────────────────────
 *
 * **The email address.** `PATCH /account` takes a name, a phone and a marketing
 * preference, and nothing else — a strict schema, so sending an email is a 422
 * rather than a silent drop. Changing the address somebody signs in with is an
 * identity change and needs a verification round trip nobody has built. The
 * form says so rather than offering a field that would be refused.
 */
export const profileApi = {
  get: () => api.get('/storefront/account'),

  update: (patch) => api.patch('/storefront/account', patch),

  addresses: () => api.get('/storefront/account/addresses'),

  createAddress: (body) => api.post('/storefront/account/addresses', body),

  updateAddress: (id, patch) => api.patch(`/storefront/account/addresses/${id}`, patch),

  /**
   * A soft archive, not a delete — an order placed to this address still
   * references it. Deleting the default promotes another, which is why the
   * caller re-reads the list rather than filtering its own copy.
   */
  removeAddress: (id) => api.delete(`/storefront/account/addresses/${id}`),
}
