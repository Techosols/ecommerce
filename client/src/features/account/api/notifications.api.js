import { api } from '@/lib/api'

/**
 * In-app notifications.
 *
 * `unreadCount` is its own endpoint so the badge in the account nav does not
 * fetch a whole page of notifications to render a number.
 *
 * Preferences are the *exceptions* a person has set, not a full matrix: an
 * absent row means enabled. That is why saving one sends a single
 * `{ type, channel, enabled }` rather than the whole grid — there is no whole
 * grid to send, and inventing one here would need this file to know every
 * notification type the server might add.
 */
export const notificationsApi = {
  list: (params = {}) =>
    api.list('/storefront/notifications', {
      query: { page: params.page, limit: params.limit, unread: params.unread },
    }),

  unreadCount: () => api.get('/storefront/notifications/unread-count'),

  markRead: (id) => api.post(`/storefront/notifications/${id}/read`, {}),

  markAllRead: () => api.post('/storefront/notifications/read-all', {}),

  preferences: () => api.get('/storefront/notifications/preferences'),

  setPreference: (body) => api.put('/storefront/notifications/preferences', body),
}
