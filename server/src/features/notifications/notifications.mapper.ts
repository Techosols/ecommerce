/**
 * Notification serialisation (§7.5).
 *
 * `data` is passed through as the subscriber wrote it — identifiers a client
 * can follow, never a whole aggregate — so the notification stays a pointer to
 * the truth rather than a second, staler copy of it.
 */
import type { Notification } from './notifications.service.js'

export function notificationDto(notification: Notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: notification.data,
    read: notification.readAt !== null,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  }
}
