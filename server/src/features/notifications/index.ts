/**
 * Public surface of the `notifications` feature (§2.2).
 *
 * Everything else reaches notifications through subscribers, never by calling
 * `notify()` from inside a request handler: the fact is raised as a domain
 * event, and the subscriber decides who should hear about it.
 */
export { notificationsService } from './notifications.service.js'
export type {
  Notification,
  NotificationAudience,
  NotificationChannel,
} from './notifications.service.js'
export { notificationDto } from './notifications.mapper.js'
