/**
 * Order serialisation (§7.5).
 *
 * Two serialisers, written separately on purpose (§23.1).
 *
 *   `customerOrderDto` — what the person who placed it may see. It shows the
 *   derived flat status, because "confirmed / shipped / delivered" is the
 *   vocabulary CLAUDE.md §17 asks for on the storefront, and it hides the admin
 *   note, the source and the internal status triple.
 *
 *   `adminOrderDto` — the operational view: all three status machines, the
 *   internal note, the audit-relevant timestamps.
 *
 * Money always leaves as `{ amount, currency }` in integer minor units.
 */
import { money } from '../catalogue/index.js'
import type {
  Order,
  OrderAddress,
  OrderDetail,
  OrderItem,
  OrderNote,
  StatusHistoryEntry,
  TimelineEntry,
} from './orders.types.js'
import { displayStatus } from './orders.service.js'

export function addressDto(address: OrderAddress) {
  return {
    type: address.type,
    firstName: address.firstName,
    lastName: address.lastName,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    phone: address.phone,
  }
}

function itemDto(item: OrderItem, currency: string) {
  return {
    id: item.id,
    // The snapshot, not a lookup: this is what was bought, at the title and
    // price it had then, even if the product has since been renamed or archived.
    productTitle: item.productTitle,
    variantTitle: item.variantTitle,
    sku: item.sku,
    imageUrl: item.imageUrl,
    options: item.options,
    quantity: item.quantity,
    unitPrice: money(item.unitPriceCents, currency),
    subtotal: money(item.subtotalCents, currency),
    discount: money(item.discountCents, currency),
    tax: money(item.taxCents, currency),
    total: money(item.totalCents, currency),
    requiresShipping: item.requiresShipping,
    fulfilledQuantity: item.fulfilledQuantity,
    refundedQuantity: item.refundedQuantity,
    /** Still useful to a client that wants to link back to a live product. */
    productId: item.productId,
    variantId: item.variantId,
  }
}

function totals(order: Order) {
  return {
    subtotal: money(order.subtotalCents, order.currency),
    discountTotal: money(order.discountTotalCents, order.currency),
    taxTotal: money(order.taxTotalCents, order.currency),
    shippingTotal: money(order.shippingTotalCents, order.currency),
    paymentFee: money(order.paymentFeeCents, order.currency),
    total: money(order.totalCents, order.currency),
    refundedTotal: money(order.refundedTotalCents, order.currency),
  }
}

/** The customer's own order. No admin note, no source, no status triple. */
export function customerOrderDto(order: OrderDetail) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.displayStatus,
    paymentState: order.paymentStatus === 'paid' ? 'paid' : order.paymentStatus === 'refunded' || order.paymentStatus === 'partially_refunded' ? 'refunded' : 'awaiting_payment',
    email: order.email,
    phone: order.phone,
    currency: order.currency,
    totals: totals(order),
    items: order.items.map((item) => itemDto(item, order.currency)),
    addresses: order.addresses.map(addressDto),
    discounts: order.discounts.map((discount) => ({
      code: discount.code,
      amount: money(discount.amountCents, order.currency),
    })),
    shippingMethodName: order.shippingMethodName,
    paymentMethod: order.paymentMethod,
    customerNote: order.customerNote,
    cancelReason: order.cancelReason,
    placedAt: order.placedAt.toISOString(),
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
  }
}

/** A row in the customer's order list. Enough to render a list, no more. */
export function customerOrderCardDto(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: displayStatus(order),
    total: money(order.totalCents, order.currency),
    placedAt: order.placedAt.toISOString(),
  }
}

export function adminOrderCardDto(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    email: order.email,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    displayStatus: displayStatus(order),
    total: money(order.totalCents, order.currency),
    refundedTotal: money(order.refundedTotalCents, order.currency),
    tags: order.tags,
    paymentMethod: order.paymentMethod,
    source: order.source,
    placedAt: order.placedAt.toISOString(),
  }
}

export function adminOrderDto(order: OrderDetail) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    email: order.email,
    phone: order.phone,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    displayStatus: order.displayStatus,
    currency: order.currency,
    totals: totals(order),
    items: order.items.map((item) => itemDto(item, order.currency)),
    addresses: order.addresses.map(addressDto),
    discounts: order.discounts.map((discount) => ({
      id: discount.id,
      discountId: discount.discountId,
      code: discount.code,
      type: discount.type,
      value: discount.value,
      amount: money(discount.amountCents, order.currency),
    })),
    shippingMethodId: order.shippingMethodId,
    shippingMethodName: order.shippingMethodName,
    paymentMethod: order.paymentMethod,
    customerNote: order.customerNote,
    adminNote: order.adminNote,
    tags: order.tags,
    cancelReason: order.cancelReason,
    source: order.source,
    placedAt: order.placedAt.toISOString(),
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    updatedAt: order.updatedAt.toISOString(),
  }
}

/**
 * Status history, staff-only.
 *
 * A customer sees the current state and the timestamps on their own order; who
 * changed what, and why, is operational (§23.1, "do not expose staff
 * information").
 */
export function statusHistoryDto(entry: StatusHistoryEntry) {
  return {
    id: entry.id,
    field: entry.field,
    from: entry.fromValue,
    to: entry.toValue,
    actorUserId: entry.actorUserId,
    actorType: entry.actorType,
    reason: entry.reason,
    note: entry.note,
    at: entry.createdAt.toISOString(),
  }
}

export function orderNoteDto(note: OrderNote) {
  return {
    id: note.id,
    body: note.body,
    authorUserId: note.authorUserId,
    authorName: note.authorName,
    at: note.createdAt.toISOString(),
  }
}

/**
 * One timeline entry, with its money already denominated.
 *
 * The `kind` discriminator is carried through unchanged so the client can
 * render each sort of event on its own terms rather than reverse-engineering
 * what happened from a sentence the server wrote.
 */
export function timelineEntryDto(entry: TimelineEntry, currency: string) {
  const base = {
    id: entry.id,
    kind: entry.kind,
    at: entry.at.toISOString(),
    actorUserId: entry.actorUserId,
    actorName: entry.actorName,
  }

  switch (entry.kind) {
    case 'status':
      return { ...base, field: entry.field, from: entry.from, to: entry.to, reason: entry.reason, note: entry.note }
    case 'note':
      return { ...base, body: entry.body }
    case 'payment':
      return {
        ...base,
        amount: money(entry.amountCents, currency),
        method: entry.method,
        provider: entry.provider,
        status: entry.status,
      }
    case 'refund':
      return { ...base, amount: money(entry.amountCents, currency), reason: entry.reason, restock: entry.restock }
    case 'shipment':
      return {
        ...base,
        status: entry.status,
        carrier: entry.carrier,
        trackingNumber: entry.trackingNumber,
        itemCount: entry.itemCount,
      }
  }
}
