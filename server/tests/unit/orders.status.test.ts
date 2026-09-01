/**
 * The derived display status (§5.6, CLAUDE.md §17).
 *
 * An order carries three orthogonal status machines. The flat vocabulary a
 * customer sees is *derived* from them and never stored — a fourth column that
 * must agree with three others is a fourth column that will eventually
 * disagree.
 *
 * These tests pin the derivation, including the precedence between states that
 * are simultaneously true: a cancelled order that was also shipped is
 * cancelled, and a delivered order that is not yet marked complete is
 * delivered.
 */
import { describe, expect, it } from 'vitest'
import { displayStatus } from '../../src/features/orders/orders.service.js'
import type { FulfillmentStatus, Order, OrderStatus, PaymentStatus } from '../../src/features/orders/index.js'

function order(
  status: OrderStatus,
  paymentStatus: PaymentStatus,
  fulfillmentStatus: FulfillmentStatus,
): Order {
  return {
    id: 'o1',
    orderNumber: '#1001',
    customerId: null,
    email: 'buyer@example.test',
    phone: null,
    status,
    paymentStatus,
    fulfillmentStatus,
    currency: 'USD',
    subtotalCents: 1000,
    discountTotalCents: 0,
    taxTotalCents: 0,
    shippingTotalCents: 0,
    paymentFeeCents: 0,
    totalCents: 1000,
    refundedTotalCents: 0,
    paymentMethod: 'cod',
    shippingMethodId: null,
    shippingMethodName: null,
    customerNote: null,
    adminNote: null,
    cancelReason: null,
    tags: [],
    source: 'storefront',
    draftedBy: null,
    placedOrderId: null,
    placedFromDraftAt: null,
    draftDiscountCode: null,
    placedAt: new Date(),
    confirmedAt: null,
    cancelledAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('displayStatus', () => {
  it('starts pending', () => {
    expect(displayStatus(order('pending', 'pending', 'unfulfilled'))).toBe('pending')
  })

  it('reads as confirmed once the money is authorised or taken', () => {
    expect(displayStatus(order('pending', 'paid', 'unfulfilled'))).toBe('confirmed')
    expect(displayStatus(order('pending', 'authorized', 'unfulfilled'))).toBe('confirmed')
  })

  it('stays pending for a COD order, which is unpaid by design', () => {
    // The customer has not paid and will not until delivery. Showing
    // "confirmed" here would be claiming money that has not arrived.
    expect(displayStatus(order('pending', 'pending', 'unfulfilled'))).toBe('pending')
  })

  it('reads as processing once the shop is working on it', () => {
    expect(displayStatus(order('processing', 'paid', 'unfulfilled'))).toBe('processing')
  })

  it('reads as shipped on a partial shipment, not only a complete one', () => {
    // Half the parcel has left. From the customer's side that is "shipped",
    // and reporting it as "processing" is how support tickets are made.
    expect(displayStatus(order('processing', 'paid', 'partially_fulfilled'))).toBe('shipped')
    expect(displayStatus(order('processing', 'paid', 'fulfilled'))).toBe('shipped')
  })

  it('prefers delivered over shipped', () => {
    expect(displayStatus(order('processing', 'paid', 'delivered'))).toBe('delivered')
  })

  it('prefers returned over delivered', () => {
    expect(displayStatus(order('completed', 'refunded', 'returned'))).toBe('returned')
  })

  it('lets cancelled win over everything', () => {
    // The one that matters most: an order cancelled after a partial shipment
    // must not still read as "shipped" to the person who cancelled it.
    expect(displayStatus(order('cancelled', 'refunded', 'partially_fulfilled'))).toBe('cancelled')
    expect(displayStatus(order('cancelled', 'pending', 'unfulfilled'))).toBe('cancelled')
  })

  it('reads as completed only when nothing else more specific applies', () => {
    expect(displayStatus(order('completed', 'paid', 'unfulfilled'))).toBe('completed')
  })
})
