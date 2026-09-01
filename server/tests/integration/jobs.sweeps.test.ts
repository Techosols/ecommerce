/**
 * The scheduled sweeps (§8.4).
 *
 * Three background jobs that touch money and stock, so each one is tested for
 * what it does *and* for what it must leave alone. The second half is the
 * important one: a sweep that cancels too eagerly destroys real business, and
 * one that never runs leaves stock held by orders nobody will pay for.
 *
 * The cash-on-delivery case is the sharpest. A COD order is unpaid by design
 * until the courier comes back, so the naive "cancel unpaid orders after 48
 * hours" would cancel every single one of them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import type { JobContext } from '../../src/infrastructure/queue/index.js'
import { expireUnpaidOrdersHandler } from '../../src/jobs/orders/expireUnpaid.job.js'
import { abandonCartsHandler } from '../../src/jobs/carts/abandonCarts.job.js'
import { analyticsRollupHandler } from '../../src/jobs/analytics/rollup.job.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  backdateOrder,
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

/** A job context that is not cancelled and logs nowhere interesting. */
function jobContext(): JobContext {
  return {
    logger: createLogger('test.job'),
    signal: new AbortController().signal,
  } as unknown as JobContext
}

describeIfDatabase('scheduled sweeps', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let keyCounter = 0

  const post = (path: string, body: object = {}) => {
    keyCounter += 1
    return request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', `00000000-0000-4000-d000-${String(keyCounter).padStart(12, '0')}`)
      .send(body)
  }

  async function placeOrder(paymentMethod = 'cod') {
    const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const res = await checkout(shopper, { paymentMethod, shippingMethodId: methodId })
    return { orderId: res.body.data.id as string, product }
  }

  const statusOf = async (orderId: string) =>
    (
      await queryOne<{ status: string; cancel_reason: string | null }>(
        `SELECT status, cancel_reason FROM orders WHERE id = $1`,
        [orderId],
      )
    )!

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

  // ── Unpaid orders ─────────────────────────────────────────────────────────

  describe('the unpaid-order sweep', () => {
    const sweep = (overrides: Partial<Parameters<typeof expireUnpaidOrdersHandler>[0]> = {}) =>
      expireUnpaidOrdersHandler(
        { afterHours: 48, codAcceptanceHours: 168, batchSize: 100, ...overrides },
        jobContext(),
      )

    it('leaves a fresh order alone', async () => {
      const { orderId } = await placeOrder()
      await sweep()
      expect((await statusOf(orderId)).status).toBe('pending')
    })

    it('never cancels a cash-on-delivery order for being unpaid', async () => {
      // The case the whole two-predicate design exists for. This order is 72
      // hours old and unpaid — which for COD is entirely normal, because the
      // money arrives with the courier. Cancelling it would be destroying a
      // sale the shop was going to make.
      const { orderId } = await placeOrder('cod')
      await backdateOrder(orderId, 72)

      await sweep({ afterHours: 48 })

      expect((await statusOf(orderId)).status).toBe('pending')
    })

    it('cancels a COD order nobody ever accepted, over a far longer window', async () => {
      // What is genuinely stuck is one the shop never confirmed. Judged on
      // confirmation rather than payment, and measured in days.
      const { orderId } = await placeOrder('cod')
      await backdateOrder(orderId, 200)

      await sweep({ codAcceptanceHours: 168 })

      const after = await statusOf(orderId)
      expect(after.status).toBe('cancelled')
      expect(after.cancel_reason).toMatch(/not accepted/i)
    })

    it('leaves an accepted COD order alone however old it is', async () => {
      // Confirmed means the shop is waiting on a courier, not on a customer.
      // Its stock is committed rather than held, so there is nothing to reclaim.
      const { orderId } = await placeOrder('cod')
      await post(`/admin/orders/${orderId}/confirm`)
      await backdateOrder(orderId, 500)

      await sweep()

      expect((await statusOf(orderId)).status).toBe('confirmed')
    })

    it('releases the stock held by an order it cancels', async () => {
      const { orderId, product } = await placeOrder('cod')
      await backdateOrder(orderId, 200)

      const before = await queryOne<{ reserved: number }>(
        `SELECT l.reserved FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [product.variants[0]!.id],
      )
      expect(before?.reserved).toBe(1)

      await sweep()

      const after = await queryOne<{ reserved: number; on_hand: number }>(
        `SELECT l.reserved, l.on_hand FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [product.variants[0]!.id],
      )
      // Released, not returned: the stock never left, so on_hand is untouched.
      expect(after).toMatchObject({ reserved: 0, on_hand: 10 })
    })

    it('records the system as the actor, not a member of staff', async () => {
      const { orderId } = await placeOrder('cod')
      await backdateOrder(orderId, 200)
      await sweep()

      const entry = await queryOne<{ actor_type: string; actor_user_id: string | null }>(
        `SELECT actor_type, actor_user_id FROM order_status_history
          WHERE order_id = $1 AND to_value = 'cancelled'`,
        [orderId],
      )
      expect(entry).toMatchObject({ actor_type: 'system', actor_user_id: null })
    })

    it('carries on after one order it cannot cancel', async () => {
      // A shipped order refuses cancellation. One awkward row must not stop the
      // sweep clearing everything behind it.
      const stuck = await placeOrder('cod')
      await post(`/admin/orders/${stuck.orderId}/confirm`)
      const detail = await request(app)
        .get(`/api/v1/admin/orders/${stuck.orderId}`)
        .set('Authorization', bearer(owner.accessToken))
      await post(`/admin/orders/${stuck.orderId}/shipments`, {
        items: [{ orderItemId: detail.body.data.items[0].id, quantity: 1 }],
      })
      await execute(`UPDATE orders SET status = 'pending' WHERE id = $1`, [stuck.orderId])
      await backdateOrder(stuck.orderId, 300)

      const fine = await placeOrder('cod')
      await backdateOrder(fine.orderId, 300)

      await sweep()

      expect((await statusOf(fine.orderId)).status).toBe('cancelled')
    })
  })

  // ── Abandoned carts ───────────────────────────────────────────────────────

  describe('the abandoned-cart sweep', () => {
    it('marks an expired cart abandoned and raises the event', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await execute(`UPDATE carts SET expires_at = now() - interval '1 day'`)

      await abandonCartsHandler({ batchSize: 100 }, jobContext())

      const cart = await queryOne<{ status: string }>(`SELECT status FROM carts LIMIT 1`)
      expect(cart?.status).toBe('abandoned')

      // The event is what a recovery email hangs off.
      const event = await queryOne<{ name: string }>(
        `SELECT name FROM domain_events WHERE name = 'cart.abandoned'`,
      )
      expect(event?.name).toBe('cart.abandoned')
    })

    it('leaves a live cart alone', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      await abandonCartsHandler({ batchSize: 100 }, jobContext())

      const cart = await queryOne<{ status: string }>(`SELECT status FROM carts LIMIT 1`)
      expect(cart?.status).toBe('active')
    })

    it('never touches a cart that has already been checked out', async () => {
      // A converted cart is the record of an order's basket. Re-marking it
      // abandoned would raise a recovery email for something already bought.
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId })
      await execute(`UPDATE carts SET expires_at = now() - interval '1 day'`)

      await abandonCartsHandler({ batchSize: 100 }, jobContext())

      const cart = await queryOne<{ status: string }>(`SELECT status FROM carts LIMIT 1`)
      expect(cart?.status).toBe('converted')
    })

    it('is safe to run twice', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await execute(`UPDATE carts SET expires_at = now() - interval '1 day'`)

      await abandonCartsHandler({ batchSize: 100 }, jobContext())
      await abandonCartsHandler({ batchSize: 100 }, jobContext())

      const events = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM domain_events WHERE name = 'cart.abandoned'`,
      )
      expect(events?.count).toBe(1)
    })
  })

  // ── Rollups ───────────────────────────────────────────────────────────────

  describe('the analytics rollup', () => {
    it('writes a row for each day in its window', async () => {
      await placeOrder()
      await analyticsRollupHandler({ days: 3 }, jobContext())

      const rows = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM analytics_daily_sales`,
      )
      expect(rows?.count).toBe(3)
    })

    it('produces the same numbers on a second run', async () => {
      // Recomputed from source rather than accumulated, which is what makes a
      // retried job harmless and a historical correction a one-liner.
      await placeOrder()
      await analyticsRollupHandler({ days: 1 }, jobContext())
      const first = await queryOne<{ orders_count: number; total_cents: string }>(
        `SELECT orders_count, total_cents FROM analytics_daily_sales ORDER BY date DESC LIMIT 1`,
      )

      await analyticsRollupHandler({ days: 1 }, jobContext())
      const second = await queryOne<{ orders_count: number; total_cents: string }>(
        `SELECT orders_count, total_cents FROM analytics_daily_sales ORDER BY date DESC LIMIT 1`,
      )

      expect(second).toEqual(first)
      expect(first?.orders_count).toBe(1)
    })

    it('reflects a cancellation on a re-run', async () => {
      const { orderId } = await placeOrder()
      await analyticsRollupHandler({ days: 1 }, jobContext())
      expect(
        (
          await queryOne<{ orders_count: number }>(
            `SELECT orders_count FROM analytics_daily_sales ORDER BY date DESC LIMIT 1`,
          )
        )?.orders_count,
      ).toBe(1)

      await post(`/admin/orders/${orderId}/cancel`, {})
      await analyticsRollupHandler({ days: 1 }, jobContext())

      const after = await queryOne<{ orders_count: number; cancelled_count: number }>(
        `SELECT orders_count, cancelled_count FROM analytics_daily_sales ORDER BY date DESC LIMIT 1`,
      )
      // The sale is gone from the takings and counted as a cancellation
      // instead — which only works because the day is recomputed, not adjusted.
      expect(after).toMatchObject({ orders_count: 0, cancelled_count: 1 })
    })
  })
})
