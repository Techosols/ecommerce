import { api } from '@/lib/api/client'
import type { DateRange, EventCount, SalesReport, TopProduct } from './analytics.types'

/**
 * The reporting endpoints.
 *
 * All behind `analytics:read`, which ordinary staff deliberately do **not**
 * hold: revenue, average order value and lifetime figures are commercial
 * information, and the person packing boxes has no operational need for them.
 * Recomputing a rollup is `reports:generate`, which is narrower still.
 *
 * ── What is rolled up and what is live ───────────────────────────────────────
 *
 * Everything here reads `analytics_daily_sales`, a table tonight's job writes.
 * It has no row for today until that job runs, so a range ending "today" would
 * quietly report a day of zero sales. The page ends its ranges yesterday and
 * says so, rather than showing a figure it knows to be incomplete.
 */
export const analyticsApi = {
  sales: (range: DateRange) =>
    api.get<SalesReport>('/admin/analytics/sales', { query: { ...range } }),

  topProducts: (range: DateRange, limit = 10) =>
    api.get<TopProduct[]>('/admin/analytics/products', { query: { ...range, limit } }),

  events: (range: DateRange) =>
    api.get<EventCount[]>('/admin/analytics/events', { query: { ...range } }),

  /**
   * Recomputes a range by hand.
   *
   * Safe to run at any time: a rollup is recomputed from the orders rather than
   * accumulated, so running it twice produces the same numbers. That is what
   * makes correcting a historical figure a button rather than a migration.
   */
  recompute: (range: DateRange) =>
    api.post<{ recomputed: number; from: string; to: string }>('/admin/analytics/rollups', range),
}
