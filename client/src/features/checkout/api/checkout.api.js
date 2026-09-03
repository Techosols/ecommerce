import { api } from '@/lib/api'

/**
 * Checkout.
 *
 * The basket is never named. Both calls take it from the session or the guest
 * cookie, which is what makes it impossible to check out somebody else's.
 *
 * ── Preview and place are the same arithmetic ────────────────────────────────
 *
 * `preview` runs the real rating, discounting and tax code — the same
 * functions `place` runs — so what the shopper is shown cannot drift from what
 * they are charged. The storefront adds nothing up.
 */
export const checkoutApi = {
  /**
   * What checkout would cost.
   *
   * Deliberately takes only a country, not a full address: quoting should not
   * require somebody to hand over their street before they have decided to
   * buy.
   */
  preview: (params) =>
    api.get('/storefront/checkout/preview', {
      query: {
        countryCode: params.countryCode,
        shippingMethodId: params.shippingMethodId,
        discountCode: params.discountCode,
        paymentMethod: params.paymentMethod,
      },
    }),

  /**
   * Places the order.
   *
   * The idempotency key is minted once per attempt, so a retry after a dropped
   * connection replays that attempt rather than making a second order and a
   * second stock reservation.
   */
  place: (body, idempotencyKey) =>
    api.post('/storefront/checkout', body, { idempotencyKey }),

  /**
   * A guest finding their own order again.
   *
   * Needs the order number *and* the email it was placed with, matches only
   * orders with no account attached, and is rate limited — without it a guest
   * checkout is a one-way door where closing the tab loses the order.
   */
  cancelAsGuest: (claim) => api.post('/storefront/orders/lookup/cancel', claim),

  lookup: (orderNumber, email) =>
    api.post('/storefront/orders/lookup', { orderNumber, email }),
}
