/**
 * Analytics (§5.10, CLAUDE.md §13).
 *
 * ── Three layers, chosen by cost ────────────────────────────────────────────
 *
 *   live      small ranges, read straight from `orders` — today's takings
 *   rollups   `analytics_daily_sales`, computed nightly — trends and the
 *             dashboard, so a year of data is 365 rows rather than a scan of
 *             every order ever placed
 *   raw       `analytics_events`, behavioural — funnels and drop-off
 *
 * The dashboard reads rollups. That is the whole reason they exist: a "sales
 * over the last year" chart that aggregates `order_items` on every page load is
 * the query that takes the store down on its best day.
 *
 * ── Recomputation, not accumulation ─────────────────────────────────────────
 *
 * A rollup for a date is **recomputed from source and upserted**, never
 * incremented. Incrementing means a retried job double-counts and a correction
 * is impossible; recomputing means running the job twice is harmless and
 * re-running last Tuesday after a late refund simply fixes last Tuesday.
 *
 * ── What counts as a sale ───────────────────────────────────────────────────
 *
 * Cancelled orders are excluded from sales and counted separately. Refunds are
 * subtracted on the day of the *order*, not the day of the refund, so a
 * product's net figure always matches the orders it appears in.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { settingsService } from '../settings/index.js'

const log = createLogger('analytics')

/**
 * ── Which day is an order on? ───────────────────────────────────────────────
 *
 * `placed_at` is `timestamptz`, so casting it to a date resolves in whatever
 * timezone the database session happens to be in. For a shop in Auckland or
 * Los Angeles that is not their day at all: "yesterday's takings" would begin
 * and end in the middle of an afternoon, and the nightly rollup and the live
 * dashboard would disagree with each other because one of them derived its date
 * string in UTC and the other did not.
 *
 * Every day-scoped query below therefore resolves the local day to a half-open
 * pair of instants (`dayBounds`) and compares the bare `placed_at` column
 * against them, and every date *string* comes from `storeToday()`.
 */

/**
 * The half-open UTC range covering one local day.
 *
 * The obvious predicate — `(placed_at AT TIME ZONE $tz)::date = $day` — is
 * correct but wraps the column in an expression, so no index on `placed_at` can
 * serve it and every rollup becomes a sequential scan of `orders`. Converting
 * the *day* to a pair of instants instead leaves the column bare, so
 * `orders_placed_at_idx` applies and the query reads only the slice it needs.
 *
 * The conversion is done by Postgres rather than in JavaScript because only the
 * database knows the timezone database — including the day a store's clocks go
 * forward and the local day is 23 hours long.
 */
async function dayBounds(date: string): Promise<{ start: Date; end: Date }> {
  const { timezone } = await settingsService.get()
  const row = await queryOne<{ start: Date; end: Date }>(
    `SELECT ($1::timestamp AT TIME ZONE $2) AS start,
            (($1::date + interval '1 day')::timestamp AT TIME ZONE $2) AS end`,
    [date, timezone],
    { name: 'analytics.dayBounds' },
  )
  if (!row) throw new Error('could not resolve the day boundaries')
  return row
}

/** The store's today, as an ISO date in its own timezone. */
export async function storeToday(): Promise<string> {
  const { timezone } = await settingsService.get()
  const row = await queryOne<{ day: string }>(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day`,
    [timezone],
    { name: 'analytics.storeToday' },
  )
  return row?.day ?? new Date().toISOString().slice(0, 10)
}



export interface DailySales {
  date: string
  ordersCount: number
  cancelledCount: number
  unitsSold: number
  grossSalesCents: number
  discountsCents: number
  refundsCents: number
  netSalesCents: number
  taxCents: number
  shippingCents: number
  totalCents: number
  aovCents: number
  newCustomers: number
  returningCustomers: number
}

interface DailyRow {
  date: Date | string
  orders_count: number
  cancelled_count: number
  units_sold: number
  gross_sales_cents: string | number
  discounts_cents: string | number
  refunds_cents: string | number
  net_sales_cents: string | number
  tax_cents: string | number
  shipping_cents: string | number
  total_cents: string | number
  aov_cents: number
  new_customers: number
  returning_customers: number
}

/** `bigint` arrives from `pg` as a string; money must not become a float. */
function int(value: string | number | null | undefined): number {
  return Number(value ?? 0)
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? (value.toISOString().slice(0, 10) as string) : String(value).slice(0, 10)
}

function toDailySales(row: DailyRow): DailySales {
  return {
    date: isoDate(row.date),
    ordersCount: row.orders_count,
    cancelledCount: row.cancelled_count,
    unitsSold: row.units_sold,
    grossSalesCents: int(row.gross_sales_cents),
    discountsCents: int(row.discounts_cents),
    refundsCents: int(row.refunds_cents),
    netSalesCents: int(row.net_sales_cents),
    taxCents: int(row.tax_cents),
    shippingCents: int(row.shipping_cents),
    totalCents: int(row.total_cents),
    aovCents: row.aov_cents,
    newCustomers: row.new_customers,
    returningCustomers: row.returning_customers,
  }
}

export const analyticsService = {
  // ── Ingestion ─────────────────────────────────────────────────────────────

  /**
   * Records a behavioural event.
   *
   * Deliberately not joined to orders: this table says what people *did*, and
   * mixing it with what they bought produces a table that is authoritative for
   * neither. `occurredAt` is clamped to a sane window so a client clock cannot
   * write events into next year and corrupt every range query after it.
   */
  async track(input: {
    name: string
    userId?: string | null
    anonymousId?: string | null
    sessionId?: string | null
    occurredAt?: Date
    properties?: Record<string, unknown>
  }): Promise<void> {
    const now = Date.now()
    const supplied = input.occurredAt?.getTime() ?? now
    const drift = 24 * 60 * 60 * 1000
    const occurredAt = new Date(Math.min(Math.max(supplied, now - drift), now))

    await execute(
      `INSERT INTO analytics_events (name, occurred_at, user_id, anonymous_id, session_id, properties)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.name,
        occurredAt,
        input.userId ?? null,
        input.anonymousId ?? null,
        input.sessionId ?? null,
        JSON.stringify(input.properties ?? {}),
      ],
      { name: 'analytics.track' },
    )
  },

  // ── Rollups ───────────────────────────────────────────────────────────────

  /**
   * Recomputes one day's sales from the orders themselves and upserts it.
   *
   * Idempotent by construction: `ON CONFLICT … DO UPDATE` with values derived
   * entirely from source rows. Running this twice for the same date produces
   * the same numbers, which is what makes a retried job and a backfill the same
   * operation.
   */
  async rollupDay(date: string): Promise<DailySales> {
    const { start, end } = await dayBounds(date)
    await execute(
      `INSERT INTO analytics_daily_sales AS d
         (date, orders_count, cancelled_count, units_sold, gross_sales_cents,
          discounts_cents, refunds_cents, net_sales_cents, tax_cents, shipping_cents,
          total_cents, aov_cents, new_customers, returning_customers, computed_at)
       SELECT
         $1::date,
         count(*) FILTER (WHERE o.status <> 'cancelled'),
         count(*) FILTER (WHERE o.status = 'cancelled'),
         coalesce(sum(i.units) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.subtotal_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.discount_total_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.refunded_total_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.subtotal_cents - o.discount_total_cents - o.refunded_total_cents)
                  FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.tax_total_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.shipping_total_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         coalesce(sum(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0),
         -- Average order value, integer-divided. A float here would be the one
         -- place money became inexact.
         coalesce(
           (sum(o.total_cents) FILTER (WHERE o.status <> 'cancelled')
            / nullif(count(*) FILTER (WHERE o.status <> 'cancelled'), 0))::int,
           0),
         -- "New" means this order was that customer's first, judged by the
         -- order history rather than by the account's creation date: someone
         -- who registered a year ago and bought today is a new customer.
         count(*) FILTER (WHERE o.status <> 'cancelled' AND o.customer_id IS NOT NULL AND o.is_first),
         count(*) FILTER (WHERE o.status <> 'cancelled' AND o.customer_id IS NOT NULL AND NOT o.is_first),
         now()
       FROM (
         SELECT o.*,
                NOT EXISTS (
                  SELECT 1 FROM orders p
                   WHERE p.customer_id = o.customer_id
                     AND p.status NOT IN ('cancelled', 'draft')
                     AND (p.placed_at, p.id) < (o.placed_at, o.id)
                ) AS is_first
           FROM orders o
          -- A bare column and a half-open range, so the index applies. The
          -- draft exclusion matches the partial index on placed_at, so it
          -- costs nothing and stops an unplaced order counting as a sale.
          WHERE o.status <> 'draft' AND o.placed_at >= $2 AND o.placed_at < $3
       ) o
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(quantity), 0)::int AS units
           FROM order_items WHERE order_id = o.id
       ) i ON true
       ON CONFLICT (date) DO UPDATE SET
         orders_count = excluded.orders_count,
         cancelled_count = excluded.cancelled_count,
         units_sold = excluded.units_sold,
         gross_sales_cents = excluded.gross_sales_cents,
         discounts_cents = excluded.discounts_cents,
         refunds_cents = excluded.refunds_cents,
         net_sales_cents = excluded.net_sales_cents,
         tax_cents = excluded.tax_cents,
         shipping_cents = excluded.shipping_cents,
         total_cents = excluded.total_cents,
         aov_cents = excluded.aov_cents,
         new_customers = excluded.new_customers,
         returning_customers = excluded.returning_customers,
         computed_at = now()`,
      [date, start, end],
      { name: 'analytics.rollupDay' },
    )

    await this.rollupProductsForDay(date)

    const row = await queryOne<DailyRow>(
      `SELECT * FROM analytics_daily_sales WHERE date = $1::date`,
      [date],
      { name: 'analytics.readDay' },
    )
    log.info({ date, orders: row?.orders_count ?? 0 }, 'daily rollup recomputed')
    return row
      ? toDailySales(row)
      : toDailySales({
          date,
          orders_count: 0,
          cancelled_count: 0,
          units_sold: 0,
          gross_sales_cents: 0,
          discounts_cents: 0,
          refunds_cents: 0,
          net_sales_cents: 0,
          tax_cents: 0,
          shipping_cents: 0,
          total_cents: 0,
          aov_cents: 0,
          new_customers: 0,
          returning_customers: 0,
        })
  },

  /**
   * Per-variant figures for a day.
   *
   * Deleted first, then reinserted, because a variant that sold yesterday and
   * not today must *disappear* from today rather than keep a stale row that an
   * upsert would never touch.
   */
  async rollupProductsForDay(date: string): Promise<void> {
    const { start, end } = await dayBounds(date)
    await execute(`DELETE FROM analytics_product_daily WHERE date = $1::date`, [date], {
      name: 'analytics.clearProductDay',
    })
    await execute(
      `INSERT INTO analytics_product_daily
         (date, variant_id, product_id, units_sold, gross_sales_cents, discounts_cents,
          refunds_cents, net_sales_cents, orders_count)
       SELECT $1::date,
              i.variant_id,
              i.product_id,
              sum(i.quantity)::int,
              sum(i.subtotal_cents),
              sum(i.discount_cents),
              -- A refund is attributed to the line it came from, by unit, so a
              -- part-refunded order does not zero a whole product's day.
              sum(i.refunded_quantity * i.unit_price_cents),
              sum(i.subtotal_cents - i.discount_cents - (i.refunded_quantity * i.unit_price_cents)),
              count(DISTINCT i.order_id)::int
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE o.placed_at >= $2 AND o.placed_at < $3
          AND o.status NOT IN ('cancelled', 'draft')
          AND i.variant_id IS NOT NULL AND i.product_id IS NOT NULL
        GROUP BY i.variant_id, i.product_id`,
      [date, start, end],
      { name: 'analytics.rollupProductDay' },
    )
  },

  /**
   * Recomputes a window of days.
   *
   * The nightly job asks for a few days rather than one: a refund recorded
   * today changes yesterday's net figure, and an order placed at 23:59 may be
   * refunded at 00:01.
   */
  async rollupRange(from: string, to: string): Promise<number> {
    const start = new Date(`${from}T00:00:00Z`)
    const end = new Date(`${to}T00:00:00Z`)
    let count = 0
    for (let day = start; day <= end; day = new Date(day.getTime() + 86_400_000)) {
      await this.rollupDay(day.toISOString().slice(0, 10))
      count += 1
    }
    return count
  },

  // ── Reading ───────────────────────────────────────────────────────────────

  async dailySeries(from: string, to: string): Promise<DailySales[]> {
    const rows = await query<DailyRow>(
      `SELECT * FROM analytics_daily_sales
        WHERE date >= $1::date AND date <= $2::date ORDER BY date`,
      [from, to],
      { name: 'analytics.dailySeries' },
    )
    return rows.map(toDailySales)
  },

  /**
   * Today's figures, read live.
   *
   * The rollup for today does not exist until tonight, and a dashboard that
   * showed nothing until midnight would be useless. This is the "small range,
   * live query" layer, and it is bounded to a single day on purpose.
   */
  async today(): Promise<DailySales> {
    const date = await storeToday()
    const { start, end } = await dayBounds(date)
    const row = await queryOne<DailyRow>(
      `SELECT $1::date AS date,
              count(*) FILTER (WHERE status <> 'cancelled')::int AS orders_count,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
              -- Units come from the lines, so "today" reports the same figure
              -- the nightly rollup will. Returning a placeholder zero here made
              -- the dashboard show no units sold until the small hours.
              coalesce(sum(units) FILTER (WHERE status <> 'cancelled'), 0)::int AS units_sold,
              coalesce(sum(subtotal_cents) FILTER (WHERE status <> 'cancelled'),0) AS gross_sales_cents,
              coalesce(sum(discount_total_cents) FILTER (WHERE status <> 'cancelled'),0) AS discounts_cents,
              coalesce(sum(refunded_total_cents) FILTER (WHERE status <> 'cancelled'),0) AS refunds_cents,
              coalesce(sum(subtotal_cents - discount_total_cents - refunded_total_cents)
                       FILTER (WHERE status <> 'cancelled'),0) AS net_sales_cents,
              coalesce(sum(tax_total_cents) FILTER (WHERE status <> 'cancelled'),0) AS tax_cents,
              coalesce(sum(shipping_total_cents) FILTER (WHERE status <> 'cancelled'),0) AS shipping_cents,
              coalesce(sum(total_cents) FILTER (WHERE status <> 'cancelled'),0) AS total_cents,
              coalesce((sum(total_cents) FILTER (WHERE status <> 'cancelled')
                        / nullif(count(*) FILTER (WHERE status <> 'cancelled'),0))::int, 0) AS aov_cents,
              -- Computed, not a placeholder. The same mistake that made
              -- units_sold read zero all day would otherwise have the
              -- dashboard reporting no new customers until the small hours.
              count(*) FILTER (WHERE status <> 'cancelled' AND customer_id IS NOT NULL AND is_first)::int
                AS new_customers,
              count(*) FILTER (WHERE status <> 'cancelled' AND customer_id IS NOT NULL AND NOT is_first)::int
                AS returning_customers
         FROM (
           SELECT o.status, o.customer_id, o.subtotal_cents, o.discount_total_cents,
                  o.refunded_total_cents, o.tax_total_cents, o.shipping_total_cents, o.total_cents,
                  (SELECT coalesce(sum(quantity), 0) FROM order_items WHERE order_id = o.id) AS units,
                  NOT EXISTS (
                    SELECT 1 FROM orders p
                     WHERE p.customer_id = o.customer_id
                       AND p.status NOT IN ('cancelled', 'draft')
                       AND (p.placed_at, p.id) < (o.placed_at, o.id)
                  ) AS is_first
             FROM orders o
            WHERE o.status <> 'draft' AND o.placed_at >= $2 AND o.placed_at < $3
         ) o`,
      [date, start, end],
      { name: 'analytics.today' },
    )
    if (!row) throw new Error('analytics.today returned no row')
    return toDailySales(row)
  },

  /** Totals across a range, from the rollups. One row, not a scan. */
  async summary(from: string, to: string) {
    const row = await queryOne<{
      orders_count: string
      units_sold: string
      gross_sales_cents: string
      discounts_cents: string
      refunds_cents: string
      net_sales_cents: string
      total_cents: string
      new_customers: string
      returning_customers: string
    }>(
      `SELECT coalesce(sum(orders_count),0) AS orders_count,
              coalesce(sum(units_sold),0) AS units_sold,
              coalesce(sum(gross_sales_cents),0) AS gross_sales_cents,
              coalesce(sum(discounts_cents),0) AS discounts_cents,
              coalesce(sum(refunds_cents),0) AS refunds_cents,
              coalesce(sum(net_sales_cents),0) AS net_sales_cents,
              coalesce(sum(total_cents),0) AS total_cents,
              coalesce(sum(new_customers),0) AS new_customers,
              coalesce(sum(returning_customers),0) AS returning_customers
         FROM analytics_daily_sales WHERE date >= $1::date AND date <= $2::date`,
      [from, to],
      { name: 'analytics.summary' },
    )
    const orders = int(row?.orders_count)
    return {
      ordersCount: orders,
      unitsSold: int(row?.units_sold),
      grossSalesCents: int(row?.gross_sales_cents),
      discountsCents: int(row?.discounts_cents),
      refundsCents: int(row?.refunds_cents),
      netSalesCents: int(row?.net_sales_cents),
      totalCents: int(row?.total_cents),
      aovCents: orders > 0 ? Math.round(int(row?.total_cents) / orders) : 0,
      newCustomers: int(row?.new_customers),
      returningCustomers: int(row?.returning_customers),
    }
  },

  async topProducts(from: string, to: string, limit: number) {
    const rows = await query<{
      product_id: string
      variant_id: string
      title: string
      variant_title: string
      units_sold: string
      net_sales_cents: string
    }>(
      `SELECT a.product_id, a.variant_id,
              p.title,
              coalesce(v.title, '') AS variant_title,
              sum(a.units_sold) AS units_sold,
              sum(a.net_sales_cents) AS net_sales_cents
         FROM analytics_product_daily a
         JOIN products p ON p.id = a.product_id
         LEFT JOIN product_variants v ON v.id = a.variant_id
        WHERE a.date >= $1::date AND a.date <= $2::date
        GROUP BY a.product_id, a.variant_id, p.title, v.title
        ORDER BY sum(a.net_sales_cents) DESC
        LIMIT $3`,
      [from, to, limit],
      { name: 'analytics.topProducts' },
    )
    return rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      title: row.title,
      variantTitle: row.variant_title,
      unitsSold: int(row.units_sold),
      netSalesCents: int(row.net_sales_cents),
    }))
  },

  /**
   * The operational counters a dashboard opens with: what needs doing now.
   *
   * These are live, not rolled up, because "orders awaiting fulfilment" is
   * useless if it is a day old.
   */
  async operationalCounters() {
    const row = await queryOne<{
      awaiting_payment: number
      awaiting_fulfillment: number
      low_stock: number
      out_of_stock: number
    }>(
      `SELECT
         -- 'draft' joins the exclusion for the same reason 'cancelled' is
         -- there: nobody is waiting for payment on an order that has not been
         -- placed.
         (SELECT count(*)::int FROM orders
           WHERE status NOT IN ('cancelled','completed','draft') AND payment_status = 'pending')
             AS awaiting_payment,
         (SELECT count(*)::int FROM orders
           WHERE status IN ('confirmed','processing') AND fulfillment_status = 'unfulfilled')
             AS awaiting_fulfillment,
         -- available is a generated column, so this reads the same number the
         -- storefront does. A NULL threshold means "use the store default",
         -- which is not the same as 0.
         (SELECT count(*)::int FROM inventory_levels l
            JOIN inventory_items it ON it.id = l.inventory_item_id
           WHERE it.track_inventory
             AND l.available > 0
             AND l.available <= coalesce(it.low_stock_threshold,
                                         (SELECT default_low_stock_threshold FROM store_settings LIMIT 1),
                                         0))
             AS low_stock,
         (SELECT count(*)::int FROM inventory_levels l
            JOIN inventory_items it ON it.id = l.inventory_item_id
           WHERE it.track_inventory AND l.available <= 0)
             AS out_of_stock`,
      [],
      { name: 'analytics.operationalCounters' },
    )
    return {
      awaitingPayment: row?.awaiting_payment ?? 0,
      awaitingFulfillment: row?.awaiting_fulfillment ?? 0,
      lowStock: row?.low_stock ?? 0,
      outOfStock: row?.out_of_stock ?? 0,
    }
  },

  /** Behavioural counts, for funnels. Raw layer, bounded by an explicit range. */
  async eventCounts(from: string, to: string) {
    const rows = await query<{ name: string; count: string }>(
      `SELECT name, count(*) AS count FROM analytics_events
        WHERE occurred_at >= $1::date AND occurred_at < ($2::date + interval '1 day')
        GROUP BY name ORDER BY count(*) DESC LIMIT 50`,
      [from, to],
      { name: 'analytics.eventCounts' },
    )
    return rows.map((row) => ({ name: row.name, count: int(row.count) }))
  },
}
