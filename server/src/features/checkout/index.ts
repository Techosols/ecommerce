/**
 * Checkout feature public surface.
 *
 * The checkout feature owns the transition from cart to order. It keeps its
 * own validation, pricing snapshot, fulfillment details, and state transitions.
 */

export { checkoutService } from './checkout.service.js'
export { checkoutRepository } from './checkout.repository.js'
export * from './checkout.types.js'
