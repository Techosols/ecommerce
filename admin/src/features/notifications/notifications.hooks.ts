import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { REALTIME_EVENTS, type NotificationCreatedPayload } from '@/lib/realtime/events'
import { useRealtimeEvent } from '@/lib/realtime/useRealtimeEvent'
import { notificationsApi } from './notifications.api'

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filters: { page: number; limit: number; unread: boolean }) =>
    ['notifications', 'list', filters] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  preferences: ['notifications', 'preferences'] as const,
}

export function useNotifications(
  filters: { page?: number; limit?: number; unread?: boolean } = {},
) {
  const params = {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    unread: filters.unread ?? false,
  }
  return useQuery({
    queryKey: notificationKeys.list(params),
    queryFn: () => notificationsApi.list(params),
  })
}

export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: () => notificationsApi.unreadCount(),
    // Realtime keeps this fresh; the interval is the floor for a tab that has
    // been open through a dropped connection.
    refetchInterval: 120_000,
    staleTime: 30_000,
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  })
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  })
}

/**
 * Keeps the notification cache honest when one arrives over the socket.
 *
 * It invalidates rather than pushing the payload into the cache. The realtime
 * message is a smaller shape than the REST DTO — no `data`, no `read` — and is
 * best-effort besides, so treating it as a signal to refetch keeps exactly one
 * source of truth instead of two representations that can disagree.
 */
export function useNotificationRealtimeSync(
  onArrive?: (payload: NotificationCreatedPayload) => void,
) {
  const queryClient = useQueryClient()

  useRealtimeEvent<NotificationCreatedPayload>(REALTIME_EVENTS.NOTIFICATION_CREATED, (payload) => {
    void queryClient.invalidateQueries({ queryKey: notificationKeys.all })
    onArrive?.(payload)
  })
}
