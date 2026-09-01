import { api } from '@/lib/api/client'
import type {
  NotificationChannel,
  NotificationDto,
  NotificationPreference,
} from './notifications.types'

/**
 * The notifications endpoints, mounted under `/admin` (already authenticated by
 * `authenticate()` + `requireStaff()` on the router, so no extra permission).
 *
 * There is deliberately no create endpoint on the server: a notification is a
 * consequence of something that happened, raised by a subscriber. The admin
 * reads and acknowledges; it never writes one.
 */
export const notificationsApi = {
  list: (params: { page?: number; limit?: number; unread?: boolean }) =>
    api.list<NotificationDto>('/admin/notifications', {
      query: {
        page: params.page,
        limit: params.limit,
        // The server parses `unread` as the literal string 'true'.
        unread: params.unread ? 'true' : undefined,
      },
    }),

  unreadCount: () => api.get<{ count: number }>('/admin/notifications/unread-count'),

  markRead: (id: string) => api.post<void>(`/admin/notifications/${id}/read`),

  markAllRead: () => api.post<{ marked: number }>('/admin/notifications/read-all'),

  preferences: () => api.get<NotificationPreference[]>('/admin/notifications/preferences'),

  setPreference: (input: { type: string; channel: NotificationChannel; enabled: boolean }) =>
    api.put<NotificationPreference>('/admin/notifications/preferences', input),
}
