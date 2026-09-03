import type { DailyFigures, TopProduct } from '@/features/dashboard/dashboard.types'
import type { Money } from '@/types/api'

/**
 * The analytics contracts, as `analytics.admin.routes.ts` serialises them.
 *
 * `DailyFigures` and `TopProduct` are reused from the dashboard rather than
 * re-declared: both screens read the same `dailyDto` and the same league table,
 * and two copies of one shape is two copies to drift.
 */
export type { DailyFigures, TopProduct }

export interface DateRange {
  from: string
  to: string
}

/** `GET /admin/analytics/sales`. */
export interface SalesReport {
  range: DateRange
  summary: {
    ordersCount: number
    unitsSold: number
    netSales: Money
    total: Money
    averageOrderValue: Money
  }
  series: DailyFigures[]
}

/**
 * `GET /admin/analytics/events` — what shoppers did on the storefront.
 *
 * Counts per event name, biggest first, capped at fifty by the server. These
 * exist only because the storefront reports them; an empty answer means nobody
 * has browsed since tracking was wired up, not that nobody visited.
 */
export interface EventCount {
  name: string
  count: number
}
