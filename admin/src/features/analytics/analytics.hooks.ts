import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { analyticsApi } from './analytics.api'
import type { DateRange } from './analytics.types'

export const analyticsKeys = {
  all: ['analytics'] as const,
  sales: (range: DateRange) => ['analytics', 'sales', range] as const,
  products: (range: DateRange, limit: number) => ['analytics', 'products', range, limit] as const,
  events: (range: DateRange) => ['analytics', 'events', range] as const,
}

/**
 * A rolled-up range changes once a night, so it is held for five minutes and
 * the previous answer stays on screen while a new range loads — moving a date
 * should redraw the charts, not blank the page and bounce the scroll position.
 */
const REPORT_OPTIONS = {
  staleTime: 5 * 60 * 1000,
  placeholderData: <T,>(previous: T) => previous,
} as const

export function useSalesReport(range: DateRange, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.sales(range),
    queryFn: () => analyticsApi.sales(range),
    enabled,
    ...REPORT_OPTIONS,
  })
}

export function useTopProducts(range: DateRange, limit = 10, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.products(range, limit),
    queryFn: () => analyticsApi.topProducts(range, limit),
    enabled,
    ...REPORT_OPTIONS,
  })
}

export function useStorefrontEvents(range: DateRange, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.events(range),
    queryFn: () => analyticsApi.events(range),
    enabled,
    ...REPORT_OPTIONS,
  })
}

/**
 * Rebuilds the rollups for a range.
 *
 * Every report on the page reads the table this writes, so all of them are
 * invalidated — showing a recomputed total beside a cached chart is two numbers
 * on one screen that cannot be reconciled.
 */
export function useRecomputeRollups() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (range: DateRange) => analyticsApi.recompute(range),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: analyticsKeys.all })
    },
  })
}
