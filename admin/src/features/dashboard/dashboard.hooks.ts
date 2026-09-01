import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import { isForbiddenError } from '@/lib/api/errors'
import { REALTIME_EVENTS } from '@/lib/realtime/events'
import { useRealtimeEvent } from '@/lib/realtime/useRealtimeEvent'
import { useAuth } from '@/features/auth/useAuth'
import type { DashboardResponse } from './dashboard.types'

export const dashboardKeys = {
  all: ['dashboard'] as const,
  overview: ['dashboard', 'overview'] as const,
}

export const dashboardApi = {
  overview: () => api.get<DashboardResponse>('/admin/analytics/dashboard'),
}

/**
 * The dashboard's single request.
 *
 * Gated on `analytics:read`, which the `staff` role does not hold — revenue is
 * commercial information and the server refuses it. Checking the permission
 * before firing turns a guaranteed 403 into a query that simply does not run,
 * so a staff operator sees the operational parts of the page rather than an
 * error banner.
 */
export function useDashboardOverview() {
  const { can } = useAuth()
  const allowed = can('analytics:read')

  return useQuery({
    queryKey: dashboardKeys.overview,
    queryFn: () => dashboardApi.overview(),
    enabled: allowed,
    staleTime: 60_000,
    retry: (failureCount, error) => !isForbiddenError(error) && failureCount < 2,
  })
}

/**
 * Marks the dashboard stale when something it counts actually happens.
 *
 * Refetching on the event rather than storing the payload keeps the server the
 * only place these numbers are computed — an order arriving does not let the
 * browser increment "orders today" itself, because it does not know whether
 * that order was counted, cancelled a second later, or placed in a different
 * timezone's day.
 */
export function useDashboardRealtimeSync(enabled = true) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
  }

  useRealtimeEvent(REALTIME_EVENTS.ADMIN_ORDER_PLACED, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_ORDER_CANCELLED, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_PAYMENT_RECEIVED, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_PAYMENT_REFUNDED, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_LOW_STOCK, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_OUT_OF_STOCK, invalidate, enabled)
  useRealtimeEvent(REALTIME_EVENTS.ADMIN_BACK_IN_STOCK, invalidate, enabled)
}
