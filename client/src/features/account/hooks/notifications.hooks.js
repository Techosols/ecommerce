import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notificationsApi } from '../api/notifications.api'
import { useAuth } from '../useAuth'

export const notificationKeys = {
  list: (params) => ['account', 'notifications', params],
  unread: ['account', 'notifications', 'unread'],
  preferences: ['account', 'notifications', 'preferences'],
}

/**
 * The badge in the account nav.
 *
 * Guarded on the session rather than left to 401: this hook is mounted by the
 * account layout, which only renders for a signed-in customer, but the guard
 * keeps it honest if it is ever used somewhere less careful.
 */
export function useUnreadCount() {
  const { isSignedIn } = useAuth()
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => notificationsApi.unreadCount(),
    enabled: isSignedIn,
    staleTime: 30 * 1000,
  })
}

export function useNotifications(params, enabled) {
  return useQuery({
    queryKey: notificationKeys.list(params),
    queryFn: () => notificationsApi.list(params),
    enabled,
    placeholderData: (previous) => previous,
  })
}

/** Reading one changes the badge, so both are re-read rather than guessed at. */
function useNotificationWrite(mutationFn) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['account', 'notifications'] })
    },
  })
}

export function useMarkRead() {
  return useNotificationWrite((id) => notificationsApi.markRead(id))
}

export function useMarkAllRead() {
  return useNotificationWrite(() => notificationsApi.markAllRead())
}

export function usePreferences(enabled) {
  return useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: () => notificationsApi.preferences(),
    enabled,
  })
}

export function useSetPreference() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body) => notificationsApi.setPreference(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationKeys.preferences }),
  })
}
