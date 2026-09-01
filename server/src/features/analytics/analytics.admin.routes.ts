/**
 * The dashboard (§7.1, §13).
 *
 * All of it behind `analytics:read`, which staff do **not** hold: revenue,
 * average order value and lifetime figures are commercial information, and the
 * person packing boxes has no operational need for them (§6.5).
 *
 * Note which endpoints read rollups and which read live. The trend, the summary
 * and the product league table read `analytics_daily_sales` — a few hundred
 * rows for a year. Only "today" and the operational counters touch `orders`
 * directly, and both are bounded to a single day or a single count.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted, ok } from '../../shared/http/respond.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { settingsService } from '../settings/index.js'
import { money } from '../catalogue/index.js'
import { analyticsService, storeToday, type DailySales } from './analytics.service.js'
import { rangeQuery, rollupSchema, topProductsQuery } from './analytics.validators.js'

function dailyDto(day: DailySales, currency: string) {
  return {
    date: day.date,
    ordersCount: day.ordersCount,
    cancelledCount: day.cancelledCount,
    unitsSold: day.unitsSold,
    grossSales: money(day.grossSalesCents, currency),
    discounts: money(day.discountsCents, currency),
    refunds: money(day.refundsCents, currency),
    netSales: money(day.netSalesCents, currency),
    tax: money(day.taxCents, currency),
    shipping: money(day.shippingCents, currency),
    total: money(day.totalCents, currency),
    averageOrderValue: money(day.aovCents, currency),
    newCustomers: day.newCustomers,
    returningCustomers: day.returningCustomers,
  }
}

export const analyticsAdminRoutes: ExpressRouter = Router()

/**
 * The single call a dashboard makes on load: today, the operational counters,
 * and the last 30 days of trend — one round trip rather than four.
 */
analyticsAdminRoutes.get(
  '/analytics/dashboard',
  requirePermission('analytics:read'),
  async (_req: Request, res: Response) => {
    const { currency } = await settingsService.get()

    // The rolled-up window ends *yesterday*, and says so.
    //
    // `analytics_daily_sales` has no row for today until tonight's job runs, so
    // a range labelled "…to today" would show a summary that silently omits
    // today's sales while the `today` block beside it shows them — two figures
    // on one screen that cannot be reconciled. Reporting the window the data
    // actually covers is the honest fix.
    const today = await storeToday()
    const to = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000)
      .toISOString()
      .slice(0, 10)

    const [todayFigures, counters, series, summary, top] = await Promise.all([
      analyticsService.today(),
      analyticsService.operationalCounters(),
      analyticsService.dailySeries(from, to),
      analyticsService.summary(from, to),
      analyticsService.topProducts(from, to, 5),
    ])

    return ok(res, {
      // Live, from the orders themselves — the only part of this response that
      // includes today.
      today: dailyDto(todayFigures, currency),
      counters,
      // What the rolled-up figures below actually cover.
      rolledUpRange: { from, to },
      summary: {
        ordersCount: summary.ordersCount,
        unitsSold: summary.unitsSold,
        grossSales: money(summary.grossSalesCents, currency),
        discounts: money(summary.discountsCents, currency),
        refunds: money(summary.refundsCents, currency),
        netSales: money(summary.netSalesCents, currency),
        total: money(summary.totalCents, currency),
        averageOrderValue: money(summary.aovCents, currency),
        newCustomers: summary.newCustomers,
        returningCustomers: summary.returningCustomers,
      },
      series: series.map((day) => dailyDto(day, currency)),
      topProducts: top.map((row) => ({
        productId: row.productId,
        variantId: row.variantId,
        title: row.title,
        variantTitle: row.variantTitle,
        unitsSold: row.unitsSold,
        netSales: money(row.netSalesCents, currency),
      })),
    })
  },
)

analyticsAdminRoutes.get(
  '/analytics/sales',
  requirePermission('analytics:read'),
  validate({ query: rangeQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof rangeQuery>>(req)
    const { currency } = await settingsService.get()
    const [series, summary] = await Promise.all([
      analyticsService.dailySeries(filter.from, filter.to),
      analyticsService.summary(filter.from, filter.to),
    ])
    return ok(res, {
      range: filter,
      summary: {
        ordersCount: summary.ordersCount,
        unitsSold: summary.unitsSold,
        netSales: money(summary.netSalesCents, currency),
        total: money(summary.totalCents, currency),
        averageOrderValue: money(summary.aovCents, currency),
      },
      series: series.map((day) => dailyDto(day, currency)),
    })
  },
)

analyticsAdminRoutes.get(
  '/analytics/products',
  requirePermission('analytics:read'),
  validate({ query: topProductsQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof topProductsQuery>>(req)
    const { currency } = await settingsService.get()
    const rows = await analyticsService.topProducts(filter.from, filter.to, filter.limit)
    return ok(
      res,
      rows.map((row) => ({
        productId: row.productId,
        variantId: row.variantId,
        title: row.title,
        variantTitle: row.variantTitle,
        unitsSold: row.unitsSold,
        netSales: money(row.netSalesCents, currency),
      })),
    )
  },
)

analyticsAdminRoutes.get(
  '/analytics/events',
  requirePermission('analytics:read'),
  validate({ query: rangeQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof rangeQuery>>(req)
    return ok(res, await analyticsService.eventCounts(filter.from, filter.to))
  },
)

/**
 * Recomputes a range by hand.
 *
 * Safe to call at any time because a rollup is recomputed from source rather
 * than accumulated — running it twice produces the same numbers. That is what
 * makes correcting a historical figure a one-line operation instead of a
 * migration.
 */
analyticsAdminRoutes.post(
  '/analytics/rollups',
  requirePermission('reports:generate'),
  validate({ body: rollupSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof rollupSchema>
    const days = await analyticsService.rollupRange(body.from, body.to)
    return accepted(res, { recomputed: days, from: body.from, to: body.to })
  },
)
