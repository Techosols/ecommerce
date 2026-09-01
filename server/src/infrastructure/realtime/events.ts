/**
 * The realtime event contract (§11.4).
 *
 * Server → client only. The single client → server message is an order-room
 * subscription request; there are no business commands over the socket, because
 * every state change must go through an authenticated, validated, audited REST
 * endpoint.
 *
 * Two rules keep this layer from becoming a second, unversioned API:
 *   • a payload never contains anything the recipient could not fetch over REST
 *   • a payload carries identifiers and changed fields, not whole aggregates
 *
 * Feature events are added here as their features land.
 */
export const REALTIME_EVENTS = {
  /** Connection acknowledgement, so a client can confirm its rooms. */
  CONNECTED: 'connection.ready',
  /** The server is shutting down; clients should back off before reconnecting. */
  SERVER_SHUTDOWN: 'connection.shutdown',

  // ── To one person (room `user:<id>`) ──────────────────────────────────────
  /** A notification row was created. The row is the durable copy; this is a nudge. */
  NOTIFICATION_CREATED: 'notification.created',

  // ── To an order room (its customer and staff) ─────────────────────────────
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_PAYMENT_UPDATED: 'order.payment_updated',
  ORDER_FULFILLMENT_UPDATED: 'order.fulfillment_updated',
  SHIPMENT_SHIPPED: 'shipment.shipped',
  SHIPMENT_DELIVERED: 'shipment.delivered',

  // ── To staff (rooms `admin`, `admin:orders`, `admin:inventory`) ───────────
  ADMIN_ORDER_PLACED: 'admin.order_placed',
  ADMIN_ORDER_CANCELLED: 'admin.order_cancelled',
  ADMIN_PAYMENT_RECEIVED: 'admin.payment_received',
  ADMIN_PAYMENT_REFUNDED: 'admin.payment_refunded',
  ADMIN_LOW_STOCK: 'admin.low_stock',
  ADMIN_OUT_OF_STOCK: 'admin.out_of_stock',
  ADMIN_BACK_IN_STOCK: 'admin.back_in_stock',
} as const

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS]

export interface ConnectedPayload {
  userId: string
  rooms: string[]
  serverTime: string
}

/** Client → server messages, all of which are subscription management. */
export const CLIENT_EVENTS = {
  SUBSCRIBE_ORDER: 'order:subscribe',
  UNSUBSCRIBE_ORDER: 'order:unsubscribe',
  REFRESH_AUTH: 'auth:refresh',
} as const
