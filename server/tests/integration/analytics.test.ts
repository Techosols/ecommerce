/**
 * Analytics (§5.10, CLAUDE.md §13).
 *
 * Four things this suite exists to hold down:
 *
 *   **The beacon is write-only and unforgeable.** It answers 202 and says
 *   nothing about what is in the table, and the user id comes from the verified
 *   session — never from the body — so nobody can attribute behaviour to
 *   somebody else.
 *
 *   **A rollup is recomputed, not accumulated.** Running the job twice for the
 *   same day produces the same numbers. That is the whole reason a retry is
 *   harmless and why re-running last Tuesday after a late refund corrects it
 *   rather than doubling it.
 *
 *   **Today is read live; history is read from rollups.** The nightly job has
 *   not run for today, and a dashboard that showed nothing until midnight would
 *   be useless — so "today" must be right before any rollup exists.
 *
 *   **Revenue is not an operational figure.** `analytics:read` is deliberately
 *   not held by the staff role: the person packing boxes has no need for the
 *   store's takings (§6.5).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createShippingMethod,
  guest,
  sellableProduct,
} from '../factories/commerce.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return { ...actual, enqueue: vi.fn(async () => 'stub-job-id') }
})

const app = createApp()

/** The store-local day the rollups are keyed by. The test database runs in UTC. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function shiftDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

interface DailyRow {
  orders_count: number
  cancelled_count: number
  units_sold: number
  gross_sales_cents: string
  discounts_cents: string
  refunds_cents: string
  net_sales_cents: string
  tax_cents: string
  shipping_cents: string
  total_cents: string
  aov_cents: number
}

describeIfDatabase('analytics', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string

  const asOwner = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))

  const rollup = (from: string, to: string, token = owner.accessToken) =>
    request(app)
      .post('/api/v1/admin/analytics/rollups')
      .set('Authorization', bearer(token))
      .send({ from, to })

  /** Places a real order through checkout, so the figures come from real rows. */
  async function placeOrder(options: { quantity?: number; priceAmount?: number } = {}) {
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: options.priceAmount ?? 5000,
      quantity: 50,
    })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, options.quantity ?? 1)
    const res = await checkout(shopper, { shippingMethodId: methodId })
    if (res.status !== 201) {
      throw new Error(`checkout failed (${res.status}): ${JSON.stringify(res.body)}`)
    }
    return { orderId: res.body.data.id as string, product }
  }

  const confirmOrder = (orderId: string) =>
    request(app)
      .post(`/api/v1/admin/orders/${orderId}/confirm`)
      .set('Authorization', bearer(owner.accessToken))
      .send({})

  const cancelOrder = (orderId: string) =>
    request(app)
      .post(`/api/v1/admin/orders/${orderId}/cancel`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ reason: 'customer changed their mind' })

  const dailyRow = (date: string) =>
    queryOne<DailyRow>(`SELECT * FROM analytics_daily_sales WHERE date = $1::date`, [date])

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── The beacon ────────────────────────────────────────────────────────────

  describe('the tracking beacon', () => {
    it('accepts an event and writes a row', async () => {
      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'product_viewed', properties: { handle: 'classic-burger' } })

      // 202, not 201: the caller is told the beacon was accepted, and nothing
      // about the table it landed in.
      expect(res.status).toBe(202)
      expect(res.body.data).toEqual({ recorded: true })

      const rows = await query<{ name: string; properties: Record<string, unknown> }>(
        `SELECT name, properties FROM analytics_events`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        name: 'product_viewed',
        properties: { handle: 'classic-burger' },
      })
    })

    it('tells a caller nothing they could read the table with', async () => {
      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'page_viewed' })

      // No id, no count, no echo of what else is stored. An analytics endpoint
      // that returned a row id would be a way to size the table.
      expect(Object.keys(res.body.data as Record<string, unknown>)).toEqual(['recorded'])

      // And there is no read route on this surface at all.
      const read = await request(app).get('/api/v1/storefront/analytics/events')
      expect(read.status).toBe(404)
    })

    it('accepts an anonymous visitor with no session at all', async () => {
      // The beacon must never fail a page, and most of the funnel happens
      // before anybody signs in.
      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({
          name: 'page_viewed',
          anonymousId: '00000000-0000-4000-8000-0000000000a1',
          sessionId: '00000000-0000-4000-8000-0000000000a2',
        })

      expect(res.status).toBe(202)
      const row = await queryOne<{ user_id: string | null; anonymous_id: string }>(
        `SELECT user_id, anonymous_id FROM analytics_events`,
      )
      expect(row?.user_id).toBeNull()
      expect(row?.anonymous_id).toBe('00000000-0000-4000-8000-0000000000a1')
    })

    it('takes the user id from the session', async () => {
      const shopper = await createUserAndLogin(app)

      await request(app)
        .post('/api/v1/storefront/analytics/events')
        .set('Authorization', bearer(shopper.accessToken))
        .send({ name: 'checkout_started' })

      const row = await queryOne<{ user_id: string | null }>(
        `SELECT user_id FROM analytics_events`,
      )
      expect(row?.user_id).toBe(shopper.user.id)
    })

    it('has no body field that could attribute an event to somebody else', async () => {
      // The strict schema is the defence: `userId` is not a key this endpoint
      // accepts, so a 422 rather than a silent drop that leaves the caller
      // believing they set it.
      const shopper = await createUserAndLogin(app)
      const victim = await createUserAndLogin(app)

      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .set('Authorization', bearer(shopper.accessToken))
        .send({ name: 'checkout_completed', userId: victim.user.id })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.details)).toMatch(/userId/)
    })

    it('refuses an event name that is not on the allowlist', async () => {
      // An open name field is a table anyone can fill with whatever they like,
      // and a cardinality explosion that makes every aggregate over it useless.
      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'free_text_whatever' })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      const count = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM analytics_events`,
      )
      expect(count?.count).toBe(0)
    })

    it('clamps an event dated in the future back to now', async () => {
      // A client clock that is a year fast would otherwise write events into
      // next year and quietly corrupt every range query that follows.
      const future = new Date(Date.now() + 400 * 86_400_000).toISOString()

      const res = await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'page_viewed', occurredAt: future })

      expect(res.status).toBe(202)
      const row = await queryOne<{ occurred_at: Date }>(
        `SELECT occurred_at FROM analytics_events`,
      )
      expect(row!.occurred_at.getTime()).toBeLessThanOrEqual(Date.now())
      // Roughly now, not merely "not in the future": a clamp to the epoch would
      // also pass the line above.
      expect(Date.now() - row!.occurred_at.getTime()).toBeLessThan(60_000)
    })

    it('clamps an event dated far in the past into the accepted window', async () => {
      // The mirror case: a stale beacon replayed from a bookmarked tab must not
      // rewrite a month that has already been reported on.
      const ancient = new Date(Date.now() - 30 * 86_400_000).toISOString()

      await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'page_viewed', occurredAt: ancient })

      const row = await queryOne<{ occurred_at: Date }>(
        `SELECT occurred_at FROM analytics_events`,
      )
      const ageHours = (Date.now() - row!.occurred_at.getTime()) / 3_600_000
      expect(ageHours).toBeLessThanOrEqual(24.1)
      expect(ageHours).toBeGreaterThan(23)
    })

    it('keeps an event dated a few minutes ago exactly where it was', async () => {
      const recent = new Date(Date.now() - 5 * 60_000)

      await request(app)
        .post('/api/v1/storefront/analytics/events')
        .send({ name: 'cart_item_added', occurredAt: recent.toISOString() })

      const row = await queryOne<{ occurred_at: Date }>(
        `SELECT occurred_at FROM analytics_events`,
      )
      expect(Math.abs(row!.occurred_at.getTime() - recent.getTime())).toBeLessThan(1000)
    })
  })

  // ── Rollups ───────────────────────────────────────────────────────────────

  describe('rollups', () => {
    it('recomputes a day from the orders themselves', async () => {
      const first = await placeOrder({ quantity: 2, priceAmount: 5000 })
      const second = await placeOrder({ quantity: 1, priceAmount: 5000 })
      await confirmOrder(first.orderId)
      await confirmOrder(second.orderId)

      const date = todayIso()
      const res = await rollup(date, date)

      expect(res.status).toBe(202)
      expect(res.body.data).toEqual({ recomputed: 1, from: date, to: date })

      const row = await dailyRow(date)
      expect(row).toMatchObject({ orders_count: 2, cancelled_count: 0, units_sold: 3 })
      // Net sales are the goods only: subtotal less discounts and refunds.
      // Shipping and tax are counted, but separately — a store that reported
      // postage as revenue would be overstating what it sold.
      expect(Number(row!.gross_sales_cents)).toBe(15_000)
      expect(Number(row!.net_sales_cents)).toBe(15_000)
      expect(Number(row!.shipping_cents)).toBe(998)
      expect(Number(row!.total_cents)).toBe(15_998)
      // Integer division, because a float here would be the one place money
      // became inexact.
      expect(row!.aov_cents).toBe(7999)
    })

    it('produces identical numbers when the same day is rolled up twice', async () => {
      // The property that makes a retried job and a backfill the same
      // operation. If the rollup accumulated, this would double.
      const { orderId } = await placeOrder({ quantity: 3 })
      await confirmOrder(orderId)
      const date = todayIso()

      await rollup(date, date)
      const first = await dailyRow(date)
      await rollup(date, date)
      const second = await dailyRow(date)

      expect(second!.orders_count).toBe(first!.orders_count)
      expect(second!.units_sold).toBe(first!.units_sold)
      expect(second!.net_sales_cents).toBe(first!.net_sales_cents)
      expect(second!.total_cents).toBe(first!.total_cents)
      expect(second).toMatchObject({ orders_count: 1, units_sold: 3 })
    })

    it('keeps the per-product figures recomputed rather than doubled', async () => {
      // The product table is deleted and reinserted for the day, so a variant
      // that stops selling disappears instead of leaving a stale row an upsert
      // would never touch.
      const { orderId } = await placeOrder({ quantity: 4 })
      await confirmOrder(orderId)
      const date = todayIso()

      await rollup(date, date)
      await rollup(date, date)

      const rows = await query<{ units_sold: number; net_sales_cents: string }>(
        `SELECT units_sold, net_sales_cents FROM analytics_product_daily WHERE date = $1::date`,
        [date],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.units_sold).toBe(4)
      expect(Number(rows[0]!.net_sales_cents)).toBe(20_000)
    })

    it('excludes a cancelled order from sales and counts it on its own', async () => {
      // A cancellation is not a sale, but it is not nothing either: dropping it
      // entirely would leave a store unable to see its own cancellation rate.
      const kept = await placeOrder({ quantity: 2 })
      const scrapped = await placeOrder({ quantity: 5 })
      await confirmOrder(kept.orderId)
      await cancelOrder(scrapped.orderId)

      const date = todayIso()
      await rollup(date, date)

      const row = await dailyRow(date)
      expect(row).toMatchObject({ orders_count: 1, cancelled_count: 1, units_sold: 2 })
      expect(Number(row!.net_sales_cents)).toBe(10_000)
    })

    it('drops a day back to zero when its only order is cancelled afterwards', async () => {
      // Re-running an old day is how a late correction is applied, so the
      // second run has to be able to take a figure *down*.
      const { orderId } = await placeOrder({ quantity: 2 })
      const date = todayIso()
      await rollup(date, date)
      expect((await dailyRow(date))!.orders_count).toBe(1)

      await cancelOrder(orderId)
      await rollup(date, date)

      const row = await dailyRow(date)
      expect(row).toMatchObject({ orders_count: 0, cancelled_count: 1, units_sold: 0 })
      expect(Number(row!.net_sales_cents)).toBe(0)
      // The product row goes with it: a cancelled order sold nothing.
      const products = await query(
        `SELECT 1 FROM analytics_product_daily WHERE date = $1::date`,
        [date],
      )
      expect(products).toHaveLength(0)
    })

    it('writes a zero row for a day with no orders at all', async () => {
      // A missing day and a day with no sales look the same on a chart only if
      // the reader guesses. The rollup states it.
      const date = shiftDays(-1)
      await rollup(date, date)

      const row = await dailyRow(date)
      expect(row).toMatchObject({ orders_count: 0, cancelled_count: 0, units_sold: 0 })
    })

    it('recomputes every day in the range it was given', async () => {
      const from = shiftDays(-2)
      const to = todayIso()

      const res = await rollup(from, to)

      expect(res.body.data.recomputed).toBe(3)
      const dates = await query<{ date: Date }>(
        `SELECT date FROM analytics_daily_sales ORDER BY date`,
      )
      expect(dates).toHaveLength(3)
    })

    it('refuses a rollup whose range runs backwards', async () => {
      const res = await rollup(todayIso(), shiftDays(-3))
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })

  // ── The dashboard ─────────────────────────────────────────────────────────

  describe('the dashboard', () => {
    it('reports today live, before any rollup has run', async () => {
      // The nightly job has not run for today and never will until tonight. A
      // dashboard that waited for it would show an empty shop all day.
      const first = await placeOrder({ quantity: 2, priceAmount: 5000 })
      await placeOrder({ quantity: 3, priceAmount: 5000 })
      await confirmOrder(first.orderId)

      const res = await asOwner('/admin/analytics/dashboard')

      expect(res.status).toBe(200)
      expect(res.body.data.today).toMatchObject({ ordersCount: 2, unitsSold: 5 })
      expect(res.body.data.today.netSales).toEqual({ amount: 25_000, currency: 'USD' })
      // And it really was live: nothing has been rolled up, so the series the
      // trend chart reads is still empty.
      expect(res.body.data.series).toEqual([])
      expect(res.body.data.summary.ordersCount).toBe(0)
    })

    it('leaves a cancelled order out of today’s takings', async () => {
      const kept = await placeOrder({ quantity: 1 })
      const scrapped = await placeOrder({ quantity: 4 })
      await confirmOrder(kept.orderId)
      await cancelOrder(scrapped.orderId)

      const res = await asOwner('/admin/analytics/dashboard')

      expect(res.body.data.today).toMatchObject({
        ordersCount: 1,
        cancelledCount: 1,
        unitsSold: 1,
      })
    })

    it('counts what is waiting on payment and what is waiting to be packed', async () => {
      // These are the two numbers somebody opens the dashboard for, and both
      // are useless if they are a day old — so they are live, not rolled up.
      const a = await placeOrder()
      const b = await placeOrder()
      await placeOrder()
      await confirmOrder(a.orderId)
      await confirmOrder(b.orderId)

      const res = await asOwner('/admin/analytics/dashboard')

      // Cash on delivery: confirming does not settle the money, so all three
      // are still awaiting payment.
      expect(res.body.data.counters.awaitingPayment).toBe(3)
      // Only a confirmed order is ready to pack; a pending one is not yet the
      // warehouse's problem.
      expect(res.body.data.counters.awaitingFulfillment).toBe(2)
    })

    it('drops a cancelled order out of the operational counters', async () => {
      const { orderId } = await placeOrder()
      await placeOrder()
      await cancelOrder(orderId)

      const res = await asOwner('/admin/analytics/dashboard')
      expect(res.body.data.counters.awaitingPayment).toBe(1)
      expect(res.body.data.counters.awaitingFulfillment).toBe(0)
    })

    it('reports the window its rolled-up figures actually cover', async () => {
      // `analytics_daily_sales` has no row for today until tonight's job runs,
      // so the rolled-up window ends *yesterday* and says so. Labelling it
      // "…to today" would put a 30-day summary that silently omits today's
      // sales next to a `today` block that includes them — two figures on one
      // screen that cannot be reconciled.
      const res = await asOwner('/admin/analytics/dashboard')

      expect(res.body.data.rolledUpRange).toEqual({ from: shiftDays(-30), to: shiftDays(-1) })
      expect(res.body.data.range).toBeUndefined()
    })

    it('fills the trend, the summary and the league table from the rollups', async () => {
      const { orderId, product } = await placeOrder({ quantity: 2, priceAmount: 5000 })
      await confirmOrder(orderId)
      // Backdated to yesterday, because the rolled-up window deliberately ends
      // there — today's figures are served live from the `today` block instead.
      const date = shiftDays(-1)
      await execute(`UPDATE orders SET placed_at = placed_at - interval '1 day'`)
      await rollup(date, date)

      const res = await asOwner('/admin/analytics/dashboard')

      expect(res.body.data.series).toHaveLength(1)
      expect(res.body.data.series[0]).toMatchObject({ date, ordersCount: 1, unitsSold: 2 })
      expect(res.body.data.summary).toMatchObject({ ordersCount: 1, unitsSold: 2 })
      expect(res.body.data.summary.netSales).toEqual({ amount: 10_000, currency: 'USD' })
      expect(res.body.data.topProducts).toHaveLength(1)
      expect(res.body.data.topProducts[0]).toMatchObject({
        productId: product.id,
        variantId: product.variants[0]!.id,
        title: 'Classic Burger',
        unitsSold: 2,
        netSales: { amount: 10_000, currency: 'USD' },
      })
    })
  })

  // ── The sales report ──────────────────────────────────────────────────────

  describe('the sales report', () => {
    it('returns the series and the totals for the range', async () => {
      const { orderId } = await placeOrder({ quantity: 2, priceAmount: 5000 })
      await confirmOrder(orderId)
      const date = todayIso()
      await rollup(date, date)

      const res = await asOwner(`/admin/analytics/sales?from=${date}&to=${date}`)

      expect(res.status).toBe(200)
      expect(res.body.data.range).toEqual({ from: date, to: date })
      expect(res.body.data.series).toHaveLength(1)
      expect(res.body.data.series[0]).toMatchObject({ date, ordersCount: 1, unitsSold: 2 })
      expect(res.body.data.summary).toMatchObject({ ordersCount: 1, unitsSold: 2 })
      expect(res.body.data.summary.netSales).toEqual({ amount: 10_000, currency: 'USD' })
      expect(res.body.data.summary.total).toEqual({ amount: 10_499, currency: 'USD' })
    })

    it('returns an empty series rather than an error for a quiet range', async () => {
      const res = await asOwner(`/admin/analytics/sales?from=${shiftDays(-7)}&to=${shiftDays(-6)}`)

      expect(res.status).toBe(200)
      expect(res.body.data.series).toEqual([])
      expect(res.body.data.summary.ordersCount).toBe(0)
    })

    it('refuses a range that runs backwards', async () => {
      const res = await asOwner(`/admin/analytics/sales?from=${todayIso()}&to=${shiftDays(-7)}`)

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('refuses a range longer than the reporting window', async () => {
      // The bound is the point: an unbounded "give me everything" is the query
      // that scans the whole table on the store's busiest day.
      const res = await asOwner('/admin/analytics/sales?from=2020-01-01&to=2021-12-31')

      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body.details)).toMatch(/400 days/)
    })

    it('refuses a request with no range at all', async () => {
      // No default range, deliberately: a missing `from` must not quietly mean
      // "since the beginning of time".
      const missingBoth = await asOwner('/admin/analytics/sales')
      const missingFrom = await asOwner(`/admin/analytics/sales?to=${todayIso()}`)
      const missingTo = await asOwner(`/admin/analytics/sales?from=${todayIso()}`)

      for (const res of [missingBoth, missingFrom, missingTo]) {
        expect(res.status).toBe(422)
        expect(res.body.code).toBe('VALIDATION_FAILED')
      }
    })

    it('refuses a date that is not a date', async () => {
      const res = await asOwner('/admin/analytics/sales?from=last-tuesday&to=today')
      expect(res.status).toBe(422)
    })
  })

  // ── Who may look ──────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('refuses the dashboard to a staff member', async () => {
      // `analytics:read` is not in the staff role. Revenue, average order value
      // and lifetime figures are commercial information; the person packing
      // boxes has no operational need for them (§6.5).
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const res = await request(app)
        .get('/api/v1/admin/analytics/dashboard')
        .set('Authorization', bearer(staff.accessToken))

      expect(res.status).toBe(403)
      // Named as a missing permission rather than a blanket refusal: the staff
      // member is legitimately on the admin surface, they simply do not hold
      // this one.
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS')
    })

    it('serves the dashboard to an owner', async () => {
      const res = await asOwner('/admin/analytics/dashboard')
      expect(res.status).toBe(200)
    })

    it('refuses the sales report and the product league table to a staff member', async () => {
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      const date = todayIso()

      const sales = await request(app)
        .get(`/api/v1/admin/analytics/sales?from=${date}&to=${date}`)
        .set('Authorization', bearer(staff.accessToken))
      const products = await request(app)
        .get(`/api/v1/admin/analytics/products?from=${date}&to=${date}`)
        .set('Authorization', bearer(staff.accessToken))

      expect(sales.status).toBe(403)
      expect(products.status).toBe(403)
    })

    it('needs reports:generate to recompute a rollup', async () => {
      // A separate permission from reading: recomputing is work the server
      // does, not a figure it hands over, and staff hold neither.
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      const date = todayIso()

      const refused = await rollup(date, date, staff.accessToken)
      expect(refused.status).toBe(403)
      expect(refused.body.code).toBe('INSUFFICIENT_PERMISSIONS')

      const allowed = await rollup(date, date)
      expect(allowed.status).toBe(202)
    })

    it('turns away a customer and an anonymous caller before any permission check', async () => {
      const shopper = await createUserAndLogin(app)

      const asCustomer = await request(app)
        .get('/api/v1/admin/analytics/dashboard')
        .set('Authorization', bearer(shopper.accessToken))
      const anonymous = await request(app).get('/api/v1/admin/analytics/dashboard')

      expect(asCustomer.status).toBe(403)
      expect(anonymous.status).toBe(401)
    })
  })
})
