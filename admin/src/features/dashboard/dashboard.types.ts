import type { Money } from '@/types/api'

/** One day, as `dailyDto` serialises it in `analytics.admin.routes.ts`. */
export interface DailyFigures {
  date: string
  ordersCount: number
  cancelledCount: number
  unitsSold: number
  grossSales: Money
  discounts: Money
  refunds: Money
  netSales: Money
  tax: Money
  shipping: Money
  total: Money
  averageOrderValue: Money
  newCustomers: number
  returningCustomers: number
}

/** The four queues an operator works through. Counted by the server. */
export interface OperationalCounters {
  awaitingPayment: number
  awaitingFulfillment: number
  lowStock: number
  outOfStock: number
}

export interface DashboardSummary {
  ordersCount: number
  unitsSold: number
  grossSales: Money
  discounts: Money
  refunds: Money
  netSales: Money
  total: Money
  averageOrderValue: Money
  newCustomers: number
  returningCustomers: number
}

export interface TopProduct {
  productId: string
  variantId: string
  title: string
  variantTitle: string | null
  unitsSold: number
  netSales: Money
}

/**
 * `GET /admin/analytics/dashboard`.
 *
 * Note `rolledUpRange`: the summary, series and league table come from
 * `analytics_daily_sales`, which has no row for today until tonight's rollup
 * job runs, so the window deliberately ends *yesterday*. The `today` block is
 * live from the orders themselves. The UI must label them separately — showing
 * them as one range is how a dashboard ends up displaying two numbers that
 * cannot be reconciled.
 */
export interface DashboardResponse {
  today: DailyFigures
  counters: OperationalCounters
  rolledUpRange: { from: string; to: string }
  summary: DashboardSummary
  series: DailyFigures[]
  topProducts: TopProduct[]
}
