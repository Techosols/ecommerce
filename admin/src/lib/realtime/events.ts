/**
 * The realtime vocabulary, copied verbatim from
 * `server/src/infrastructure/realtime/events.ts`.
 *
 * Nothing here is invented. An event name that does not appear on the server
 * is an event that will never arrive, and the failure is silent — which is why
 * this file exists at all rather than string literals scattered through
 * components.
 */
export const REALTIME_EVENTS = {
  CONNECTED: 'connection.ready',
  SERVER_SHUTDOWN: 'connection.shutdown',

  NOTIFICATION_CREATED: 'notification.created',

  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_PAYMENT_UPDATED: 'order.payment_updated',
  ORDER_FULFILLMENT_UPDATED: 'order.fulfillment_updated',

  SHIPMENT_SHIPPED: 'shipment.shipped',
  SHIPMENT_DELIVERED: 'shipment.delivered',

  ADMIN_ORDER_PLACED: 'admin.order_placed',
  ADMIN_ORDER_CANCELLED: 'admin.order_cancelled',
  ADMIN_PAYMENT_RECEIVED: 'admin.payment_received',
  ADMIN_PAYMENT_REFUNDED: 'admin.payment_refunded',
  ADMIN_LOW_STOCK: 'admin.low_stock',
  ADMIN_OUT_OF_STOCK: 'admin.out_of_stock',
  ADMIN_BACK_IN_STOCK: 'admin.back_in_stock',
} as const

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS]

/** Events the client may emit. `SUBSCRIBE_ORDER` is not enabled server-side yet. */
export const CLIENT_EVENTS = {
  SUBSCRIBE_ORDER: 'order:subscribe',
  UNSUBSCRIBE_ORDER: 'order:unsubscribe',
  REFRESH_AUTH: 'auth:refresh',
} as const

/**
 * Sent by the server immediately after a successful handshake.
 *
 * `rooms` is what the server decided this socket may hear, derived from the
 * verified token — an admin socket is joined to `admin`, `admin:orders`,
 * `admin:inventory`, `admin:payments` and `user:<id>` without asking. The
 * client never names a room and could not join one if it did.
 */
export interface ConnectedPayload {
  userId: string
  rooms: string[]
  serverTime: string
}

/**
 * The realtime copy of a notification.
 *
 * Deliberately smaller than the REST DTO — no `data`, no `read` — because it is
 * a nudge, not a record. The row fetched from `/notifications` is the durable
 * copy, and realtime is best-effort by design: an operator who was offline when
 * this fired still sees the notification on their next page load.
 */
export interface NotificationCreatedPayload {
  id: string
  type: string
  title: string
  body: string | null
  createdAt: string
}

/** `admin.order_placed`, to the `admin:orders` room. Money is still minor units. */
export interface AdminOrderPlacedPayload {
  orderId: string
  orderNumber: string
  totalCents: number
  currency: string
}

/** `admin.low_stock` / `admin.out_of_stock`, to the `admin:inventory` room. */
export interface AdminStockPayload {
  variantId: string
  available: number
  threshold?: number
}

/** `admin.payment_received` / `admin.payment_refunded`, to `admin:payments`. */
export interface AdminPaymentPayload {
  orderId: string
  paymentId: string
  amountCents: number
}
