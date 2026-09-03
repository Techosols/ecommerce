/**
 * Reactions to commerce events (§12.3).
 *
 * This is where an order stops being a database row and becomes something
 * people are told about. Three channels come off the same fact:
 *
 *   email        the durable record, sent to the address on the order
 *   notification a row and an unread badge, for signed-in customers and staff
 *   realtime     a socket nudge, best-effort, for whoever is looking right now
 *
 * The features themselves know about none of this. `ordersService` raises
 * `order.placed`; whether that becomes an email, a badge, both, or nothing at
 * all is decided here, on one screen, which is the whole point of the
 * subscriber layer.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Outbox dispatch is at-least-once, so every side effect here is keyed:
 * emails by `dedupeKey`, notifications by `dedupe_key` with `ON CONFLICT DO
 * NOTHING`. A redelivered event produces one email and one badge. Realtime
 * emits are not keyed, because a duplicate socket frame is harmless and the
 * durable copy is the notification row.
 *
 * ── Guests ──────────────────────────────────────────────────────────────────
 *
 * A guest order has an email but no `userId`. Emails go out; notifications do
 * not, because there is nobody to address them to. That asymmetry is why the
 * two are separate concepts rather than "an email we also stored".
 */
import { env } from '../../config/index.js'
import { emailService } from '../../infrastructure/email/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import {
  REALTIME_EVENTS,
  ROOMS,
  emitToAdminRoom,
  emitToOrder,
} from '../../infrastructure/realtime/index.js'
import { formatMoney } from '../../shared/format/money.js'
import { cartsService } from '../../features/carts/index.js'
import { discountsService } from '../../features/discounts/index.js'
import { notificationsService } from '../../features/notifications/index.js'
import { ordersService } from '../../features/orders/index.js'
import { settingsService } from '../../features/settings/index.js'
import { usersService } from '../../features/users/index.js'
import { on } from './index.js'

const log = createLogger('events.orders')

function orderUrl(orderId: string): string {
  return `${env.CLIENT_ORIGIN}/orders/${orderId}`
}

/** Staff see the order in the console; customers see it on the storefront. */
function adminOrderUrl(orderId: string): string {
  return `${env.CLIENT_ORIGIN}/admin/orders/${orderId}`
}

/** One address, on one line, the way a person reads one off a screen. */
function oneLineAddress(address: {
  firstName: string
  lastName: string
  line1: string
  line2: string | null
  city: string
  postalCode: string | null
  countryCode: string
} | undefined): string {
  if (!address) return '—'
  return [
    `${address.firstName} ${address.lastName}`,
    address.line1,
    address.line2,
    address.city,
    address.postalCode,
    address.countryCode,
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * Emails the shop's own staff, if anybody is listed.
 *
 * One address per message rather than one message to many, so a bounce from the
 * warehouse address does not take the accountant's copy with it, and so the
 * dedupe key stays per-recipient. Nobody listed is a valid configuration and
 * means exactly what it says — no alerts.
 */
async function notifyStaffByEmail<T extends Parameters<typeof emailService.enqueue>[0]>(
  build: (to: string) => T,
): Promise<void> {
  const settings = await settingsService.get()
  for (const to of settings.adminNotificationEmails) {
    await emailService.enqueue(build(to))
  }
}

async function firstNameFor(userId: string | null): Promise<string | undefined> {
  if (!userId) return undefined
  const user = await usersService.getById(userId)
  return user?.firstName ?? undefined
}

/**
 * Notifies the order's customer, if there is one.
 *
 * A guest order silently skips this — which is correct, not a gap: there is no
 * account to attach an unread badge to.
 */
async function notifyCustomer(input: {
  customerId: string | null
  type: string
  title: string
  body: string
  orderId: string
  eventId: string
}): Promise<void> {
  if (!input.customerId) return
  await notificationsService.notify({
    userId: input.customerId,
    audience: 'customer',
    type: input.type,
    title: input.title,
    body: input.body,
    data: { orderId: input.orderId },
    dedupeKey: `${input.type}:${input.eventId}`,
  })
}

export function registerOrderSubscribers(): void {
  // ── Placed ────────────────────────────────────────────────────────────────

  on('order.placed', [
    async (event) => {
      const order = await ordersService.detail(event.payload.orderId)
      const settings = await settingsService.get()
      const shipping = order.addresses.find((address) => address.type === 'shipping')

      await emailService.enqueue({
        to: order.email,
        template: 'order-placed',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          placedAt: order.placedAt.toISOString().slice(0, 10),
          items: order.items.map((item) => ({
            title: item.productTitle,
            ...(item.variantTitle ? { variant: item.variantTitle } : {}),
            quantity: item.quantity,
            total: formatMoney(item.totalCents, order.currency),
          })),
          subtotal: formatMoney(order.subtotalCents, order.currency),
          ...(order.discountTotalCents > 0
            ? { discount: formatMoney(order.discountTotalCents, order.currency) }
            : {}),
          shipping: formatMoney(order.shippingTotalCents, order.currency),
          ...(order.taxTotalCents > 0
            ? { tax: formatMoney(order.taxTotalCents, order.currency) }
            : {}),
          total: formatMoney(order.totalCents, order.currency),
          shippingAddress: shipping
            ? [
                `${shipping.firstName} ${shipping.lastName}`,
                shipping.line1,
                shipping.line2,
                shipping.city,
                shipping.postalCode,
                shipping.countryCode,
              ]
                .filter(Boolean)
                .join(', ')
            : '—',
          ...(order.shippingMethodName ? { shippingMethod: order.shippingMethodName } : {}),
          orderUrl: orderUrl(order.id),
        },
        dedupeKey: `order-placed:${order.id}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'order.placed',
        title: `Order ${order.orderNumber} received`,
        body: `Thank you — we have your order for ${formatMoney(order.totalCents, order.currency)}.`,
        orderId: order.id,
        eventId: event.eventId,
      })

      // Staff want to know immediately; this is the one that makes a new order
      // appear on the console without anyone refreshing.
      await notificationsService.notifyStaff({
        type: 'order.placed',
        title: `New order ${order.orderNumber}`,
        body: `${formatMoney(order.totalCents, order.currency)} — ${order.items.length} line(s).`,
        data: { orderId: order.id, url: adminOrderUrl(order.id) },
        dedupeKey: `order-placed:${order.id}`,
      })
      emitToAdminRoom(ROOMS.adminOrders(), REALTIME_EVENTS.ADMIN_ORDER_PLACED, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalCents: order.totalCents,
        currency: order.currency,
      })

      /**
       * And the same news by email, for whoever is not looking at the console.
       *
       * A fuller message than the customer's: it carries the payment method and
       * whether the money has actually arrived, which is the difference between
       * "pack this" and "wait". `actionNeeded` says so in one line at the top,
       * because an unpaid order that looks like a paid one is how something
       * ships for free.
       */
      const billing = order.addresses.find((address) => address.type === 'billing')
      const paid = order.paymentStatus === 'paid'
      await notifyStaffByEmail((to) => ({
        to,
        template: 'admin-order-placed' as const,
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          placedAt: order.placedAt.toISOString().slice(0, 16).replace('T', ' '),
          customerEmail: order.email,
          ...(order.phone ? { customerPhone: order.phone } : {}),
          ...(shipping ? { customerName: `${shipping.firstName} ${shipping.lastName}` } : {}),
          items: order.items.map((item) => ({
            title: item.productTitle,
            ...(item.variantTitle ? { variant: item.variantTitle } : {}),
            ...(item.sku ? { sku: item.sku } : {}),
            quantity: item.quantity,
            total: formatMoney(item.totalCents, order.currency),
          })),
          subtotal: formatMoney(order.subtotalCents, order.currency),
          ...(order.discountTotalCents > 0
            ? { discount: formatMoney(order.discountTotalCents, order.currency) }
            : {}),
          shipping: formatMoney(order.shippingTotalCents, order.currency),
          ...(order.taxTotalCents > 0
            ? { tax: formatMoney(order.taxTotalCents, order.currency) }
            : {}),
          total: formatMoney(order.totalCents, order.currency),
          paymentMethod: order.paymentMethod,
          paymentStatus: paid ? 'Paid' : 'Awaiting payment',
          ...(paid ? {} : { actionNeeded: 'Not paid yet — do not ship.' }),
          shippingAddress: oneLineAddress(shipping),
          ...(billing ? { billingAddress: oneLineAddress(billing) } : {}),
          ...(order.shippingMethodName ? { shippingMethod: order.shippingMethodName } : {}),
          ...(order.customerNote ? { customerNote: order.customerNote } : {}),
          adminUrl: adminOrderUrl(order.id),
        },
        dedupeKey: `admin-order-placed:${order.id}:${to}`,
      }))
    },
  ])

  // ── A receipt is waiting ──────────────────────────────────────────────────

  /**
   * Somebody has paid by bank transfer and is waiting on a human.
   *
   * This one is more time-sensitive than a new order: the customer has sent
   * money and their order is sitting unpaid until a member of staff compares
   * their screenshot against the bank statement. The email carries the claim so
   * it can be searched for in a statement from a phone, and a link to the queue
   * — never the image, which is not something to decide about in an inbox.
   */
  on('payment.proof_submitted', [
    async (event) => {
      const settings = await settingsService.get()
      const payload = event.payload

      await notificationsService.notifyStaff({
        type: 'payment.proof_submitted',
        title: `Receipt to review — ${payload.orderNumber}`,
        body: `${payload.claimedSenderName} says they sent ${formatMoney(payload.totalCents, payload.currency)}.`,
        data: { orderId: payload.orderId, url: `${env.CLIENT_ORIGIN}/admin/payments` },
        dedupeKey: `payment-proof:${payload.proofId}`,
      })

      await notifyStaffByEmail((to) => ({
        to,
        template: 'admin-payment-proof' as const,
        props: {
          storeName: settings.storeName,
          orderNumber: payload.orderNumber,
          total: formatMoney(payload.totalCents, payload.currency),
          customerEmail: payload.email,
          claimedSenderName: payload.claimedSenderName,
          claimedSenderBank: payload.claimedSenderBank,
          ...(payload.claimedAccountLast4
            ? { claimedAccountLast4: payload.claimedAccountLast4 }
            : {}),
          reviewUrl: `${env.CLIENT_ORIGIN}/admin/payments`,
        },
        dedupeKey: `admin-payment-proof:${payload.proofId}:${to}`,
      }))
    },
  ])

  // ── Status ────────────────────────────────────────────────────────────────

  /**
   * The socket nudge for anyone watching this order.
   *
   * Identifiers and the changed field only — never the whole order — because a
   * realtime payload that carries an aggregate becomes a second, unversioned
   * API that nobody validates (§11.4).
   */
  on('order.status_changed', [
    async (event) => {
      const eventName =
        event.payload.field === 'payment_status'
          ? REALTIME_EVENTS.ORDER_PAYMENT_UPDATED
          : event.payload.field === 'fulfillment_status'
            ? REALTIME_EVENTS.ORDER_FULFILLMENT_UPDATED
            : REALTIME_EVENTS.ORDER_STATUS_CHANGED

      emitToOrder(event.payload.orderId, eventName, {
        orderId: event.payload.orderId,
        field: event.payload.field,
        from: event.payload.from,
        to: event.payload.to,
      })
    },
  ])

  on('order.confirmed', [
    async (event) => {
      const order = await ordersService.getRaw(event.payload.orderId)
      const settings = await settingsService.get()

      await emailService.enqueue({
        to: order.email,
        template: 'order-confirmed',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          total: formatMoney(order.totalCents, order.currency),
          orderUrl: orderUrl(order.id),
        },
        dedupeKey: `order-confirmed:${order.id}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'order.confirmed',
        title: `Order ${order.orderNumber} confirmed`,
        body: 'Payment received. We are preparing your order.',
        orderId: order.id,
        eventId: event.eventId,
      })
    },
  ])

  on('order.cancelled', [
    async (event) => {
      const order = await ordersService.getRaw(event.payload.orderId)
      const settings = await settingsService.get()

      await emailService.enqueue({
        to: order.email,
        template: 'order-cancelled',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          // Money already taken is money that has to come back, and saying so
          // here is what stops the "where is my refund?" email.
          refundExpected: order.paymentStatus === 'paid' || order.paymentStatus === 'partially_refunded',
          orderUrl: orderUrl(order.id),
        },
        dedupeKey: `order-cancelled:${order.id}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'order.cancelled',
        title: `Order ${order.orderNumber} cancelled`,
        body: event.payload.reason ?? 'This order will not be sent.',
        orderId: order.id,
        eventId: event.eventId,
      })

      emitToAdminRoom(ROOMS.adminOrders(), REALTIME_EVENTS.ADMIN_ORDER_CANCELLED, {
        orderId: order.id,
        orderNumber: order.orderNumber,
      })

      // A cancelled order gives its discount use back, so a limited code is not
      // burned by an order that never happened. Deleting the redemption row is
      // idempotent, which is what makes this safe on a redelivery.
      await discountsService.releaseRedemption(order.id)
    },
  ])

  // ── Money ─────────────────────────────────────────────────────────────────

  on('payment.succeeded', [
    async (event) => {
      emitToOrder(event.payload.orderId, REALTIME_EVENTS.ORDER_PAYMENT_UPDATED, {
        orderId: event.payload.orderId,
        paymentId: event.payload.paymentId,
        amountCents: event.payload.amountCents,
      })
      await notificationsService.notifyStaff({
        type: 'payment.succeeded',
        title: `Payment for ${event.payload.orderNumber}`,
        body: 'A payment has been recorded.',
        data: { orderId: event.payload.orderId, url: adminOrderUrl(event.payload.orderId) },
        dedupeKey: `payment-succeeded:${event.payload.paymentId}`,
      })
      emitToAdminRoom(ROOMS.adminPayments(), REALTIME_EVENTS.ADMIN_PAYMENT_RECEIVED, {
        orderId: event.payload.orderId,
        paymentId: event.payload.paymentId,
        amountCents: event.payload.amountCents,
      })
    },
  ])

  on('payment.refunded', [
    async (event) => {
      const order = await ordersService.getRaw(event.payload.orderId)
      const settings = await settingsService.get()

      await emailService.enqueue({
        to: order.email,
        template: 'order-refunded',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          amount: formatMoney(event.payload.amountCents, order.currency),
          full: order.refundedTotalCents >= order.totalCents,
          orderUrl: orderUrl(order.id),
        },
        // Keyed on the refund, not the order: a second, later refund is a
        // second, different email.
        dedupeKey: `order-refunded:${event.payload.refundId}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'payment.refunded',
        title: `Refund of ${formatMoney(event.payload.amountCents, order.currency)}`,
        body: `Issued against order ${order.orderNumber}.`,
        orderId: order.id,
        eventId: event.eventId,
      })

      emitToAdminRoom(ROOMS.adminPayments(), REALTIME_EVENTS.ADMIN_PAYMENT_REFUNDED, {
        orderId: order.id,
        refundId: event.payload.refundId,
        amountCents: event.payload.amountCents,
      })
    },
  ])

  // ── Goods ─────────────────────────────────────────────────────────────────

  on('shipment.shipped', [
    async (event) => {
      const order = await ordersService.getRaw(event.payload.orderId)
      const settings = await settingsService.get()

      await emailService.enqueue({
        to: order.email,
        template: 'order-shipped',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          ...(event.payload.carrier ? { carrier: event.payload.carrier } : {}),
          ...(event.payload.trackingNumber ? { trackingNumber: event.payload.trackingNumber } : {}),
          ...(event.payload.trackingUrl ? { trackingUrl: event.payload.trackingUrl } : {}),
          orderUrl: orderUrl(order.id),
        },
        dedupeKey: `order-shipped:${event.payload.shipmentId}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'shipment.shipped',
        title: `Order ${order.orderNumber} is on its way`,
        body: event.payload.trackingNumber
          ? `Tracking ${event.payload.trackingNumber}.`
          : 'Your parcel has left us.',
        orderId: order.id,
        eventId: event.eventId,
      })

      emitToOrder(order.id, REALTIME_EVENTS.SHIPMENT_SHIPPED, {
        orderId: order.id,
        shipmentId: event.payload.shipmentId,
        trackingNumber: event.payload.trackingNumber,
      })
    },
  ])

  on('shipment.delivered', [
    async (event) => {
      const order = await ordersService.getRaw(event.payload.orderId)
      const settings = await settingsService.get()

      await emailService.enqueue({
        to: order.email,
        template: 'order-delivered',
        props: {
          storeName: settings.storeName,
          orderNumber: order.orderNumber,
          ...(await firstNameFor(order.customerId).then((name) => (name ? { firstName: name } : {}))),
          orderUrl: orderUrl(order.id),
        },
        dedupeKey: `order-delivered:${event.payload.shipmentId}`,
      })

      await notifyCustomer({
        customerId: order.customerId,
        type: 'shipment.delivered',
        title: `Order ${order.orderNumber} delivered`,
        body: 'We hope everything is as it should be.',
        orderId: order.id,
        eventId: event.eventId,
      })

      emitToOrder(order.id, REALTIME_EVENTS.SHIPMENT_DELIVERED, {
        orderId: order.id,
        shipmentId: event.payload.shipmentId,
      })
    },
  ])

  // ── Carts ─────────────────────────────────────────────────────────────────

  /**
   * The abandoned-basket email.
   *
   * Three conditions, all of which must hold, and all of which are checked
   * rather than assumed:
   *
   *   • the cart belongs to a known customer (a guest has no address on file)
   *   • the basket is not empty
   *   • the customer accepts marketing *and* has not turned this notification
   *     type off
   *
   * This is the only marketing email in the system, and it is the only place
   * consent is consulted — a transactional order email is sent regardless,
   * because it is a record of a purchase rather than an approach.
   */
  on('cart.abandoned', [
    async (event) => {
      const customerId = event.payload.customerId
      if (!customerId) return

      const user = await usersService.getById(customerId)
      if (!user) return

      const allowed = await notificationsService.allows(customerId, 'cart.abandoned', 'email')
      if (!allowed) {
        log.debug({ customerId }, 'abandoned-cart email suppressed by preference')
        return
      }

      const cart = await cartsService.resolve(event.payload.cartId)
      if (cart.lines.length === 0) return

      const settings = await settingsService.get()
      await emailService.enqueue({
        to: user.email,
        template: 'cart-abandoned',
        props: {
          storeName: settings.storeName,
          ...(user.firstName ? { firstName: user.firstName } : {}),
          items: cart.lines.map((line) => ({
            title: line.productTitle,
            ...(line.variantTitle ? { variant: line.variantTitle } : {}),
            quantity: line.quantity,
          })),
          cartUrl: `${env.CLIENT_ORIGIN}/cart`,
        },
        // One per cart, not one per sweep: the job is idempotent and will see
        // this cart again if it is ever re-abandoned under a new id.
        dedupeKey: `cart-abandoned:${event.payload.cartId}`,
        category: 'marketing',
      })
    },
  ])
}
