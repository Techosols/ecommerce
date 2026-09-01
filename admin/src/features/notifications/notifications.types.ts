/** Mirrors `notificationDto` in `server/src/features/notifications/notifications.mapper.ts`. */
export interface NotificationDto {
  id: string
  type: string
  title: string
  body: string | null
  /**
   * Identifiers the admin can follow — an `orderId`, a `variantId`. Never a
   * whole aggregate: the notification is a pointer to the truth, not a second
   * copy of it, so acting on one means fetching the record it names.
   */
  data: Record<string, unknown> | null
  read: boolean
  readAt: string | null
  createdAt: string
}

export interface NotificationPreference {
  type: string
  channel: NotificationChannel
  enabled: boolean
}

export type NotificationChannel = 'in_app' | 'email' | 'realtime'

/**
 * The types the server's subscribers actually raise, from
 * `server/src/events/subscribers/`.
 *
 * The list is open — `type` is a free string on the wire — so anything not
 * named here still renders with a neutral fallback rather than disappearing.
 */
export const NOTIFICATION_TYPES = [
  'order.placed',
  'order.confirmed',
  'order.cancelled',
  'payment.succeeded',
  'payment.refunded',
  'shipment.shipped',
  'shipment.delivered',
  'inventory.low_stock',
  'inventory.out_of_stock',
  'job.dead_lettered',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number] | (string & {})

/** Which operational area a notification belongs to, for grouping and icons. */
export type NotificationGroup = 'orders' | 'payments' | 'shipping' | 'inventory' | 'system'

export function groupOf(type: string): NotificationGroup {
  if (type.startsWith('order.')) return 'orders'
  if (type.startsWith('payment.')) return 'payments'
  if (type.startsWith('shipment.')) return 'shipping'
  if (type.startsWith('inventory.')) return 'inventory'
  return 'system'
}
