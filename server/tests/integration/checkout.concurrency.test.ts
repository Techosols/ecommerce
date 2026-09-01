/**
 * Checkout under concurrency (§18.3).
 *
 * These are the tests the transaction boundary exists to pass. Everything else
 * in checkout can be re-derived from a schema; selling the same unit twice
 * cannot be undone, and a coupon spent twice is money the shop does not get
 * back.
 *
 * Every case runs real, simultaneous requests against real PostgreSQL. There is
 * no in-process mutex anywhere in the implementation — that would be worthless
 * the moment a second Node process started — so what is under test is the
 * database's own guarantee: a conditional `UPDATE` takes the row lock as part
 * of the write, and a blocked writer re-evaluates its `WHERE` against the
 * committed new version before proceeding.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { getPool } from '../../src/infrastructure/database/pool.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createDiscount,
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

describeIfDatabase('checkout under concurrency', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string

  /** Fills a fresh guest basket, ready to race. */
  async function basket(variantId: string, quantity = 1) {
    const shopper = guest(app)
    await addToCart(shopper, variantId, quantity)
    return shopper
  }

  beforeAll(async () => {
    await setupDatabase()
    // Overlapping requests need overlapping connections; one would serialise
    // them and these tests would pass without proving anything.
    expect(getPool().options.max ?? 0).toBeGreaterThan(1)
  })
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Stock ─────────────────────────────────────────────────────────────────

  describe('the last unit', () => {
    it('sells it exactly once when two people check out together', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 1 })
      const variantId = product.variants[0]!.id
      const [a, b] = await Promise.all([basket(variantId), basket(variantId)])

      const results = await Promise.all([
        checkout(a, { shippingMethodId: methodId, email: 'a@example.test' }),
        checkout(b, { shippingMethodId: methodId, email: 'b@example.test' }),
      ])

      const statuses = results.map((r) => r.status).sort()
      expect(statuses).toEqual([201, 422])

      const loser = results.find((r) => r.status === 422)!
      expect(loser.body.code).toBe('INSUFFICIENT_STOCK')

      // One order, and the shelf is empty rather than negative.
      const orders = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM orders`,
      )
      expect(orders?.count).toBe(1)

      const level = await queryOne<{ on_hand: number; reserved: number; available: number }>(
        `SELECT l.on_hand, l.reserved, l.available FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [variantId],
      )
      expect(level).toMatchObject({ on_hand: 1, reserved: 1, available: 0 })
    })

    it('never lets available go negative, however many race for it', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 5 })
      const variantId = product.variants[0]!.id
      const baskets = await Promise.all(
        Array.from({ length: 10 }, () => basket(variantId, 2)),
      )

      const results = await Promise.all(
        baskets.map((shopper, i) =>
          checkout(shopper, { shippingMethodId: methodId, email: `r${i}@example.test` }),
        ),
      )

      // 5 units, two per basket: exactly two orders can be satisfied.
      expect(results.filter((r) => r.status === 201)).toHaveLength(2)

      const level = await queryOne<{ available: number; reserved: number }>(
        `SELECT l.available, l.reserved FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [variantId],
      )
      expect(level!.available).toBeGreaterThanOrEqual(0)
      expect(level!.reserved).toBe(4)
    })

    it('leaves no half-placed order behind when a line loses the race', async () => {
      // The transaction boundary is the point: the loser must have no order,
      // no items, no addresses and no hold — not an order with some of those.
      const product = await sellableProduct(app, owner.accessToken, { quantity: 1 })
      const variantId = product.variants[0]!.id
      const [a, b] = await Promise.all([basket(variantId), basket(variantId)])

      await Promise.all([
        checkout(a, { shippingMethodId: methodId, email: 'a@example.test' }),
        checkout(b, { shippingMethodId: methodId, email: 'b@example.test' }),
      ])

      const counts = await queryOne<{ orders: number; items: number; addresses: number }>(
        `SELECT (SELECT count(*)::int FROM orders) AS orders,
                (SELECT count(*)::int FROM order_items) AS items,
                (SELECT count(*)::int FROM order_addresses) AS addresses`,
      )
      // One order, its one line, and its two addresses. Nothing orphaned.
      expect(counts).toMatchObject({ orders: 1, items: 1, addresses: 2 })
    })
  })

  // ── Coupons ───────────────────────────────────────────────────────────────

  describe('the last use of a code', () => {
    it('is spent exactly once when several checkouts race for it', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 50 })
      const variantId = product.variants[0]!.id
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'fixed_amount',
        value: 1000,
        usageLimitTotal: 1,
      })

      const baskets = await Promise.all(Array.from({ length: 4 }, () => basket(variantId)))
      const results = await Promise.all(
        baskets.map((shopper, i) =>
          checkout(shopper, {
            shippingMethodId: methodId,
            discountCode: discount.code,
            email: `c${i}@example.test`,
          }),
        ),
      )

      const winners = results.filter((r) => r.status === 201)
      expect(winners).toHaveLength(1)
      expect(winners[0]!.body.data.totals.discountTotal.amount).toBe(1000)

      for (const loser of results.filter((r) => r.status !== 201)) {
        expect(loser.body.code).toBe('DISCOUNT_USAGE_EXCEEDED')
      }

      // The counter and the ledger it summarises must agree.
      const row = await queryOne<{ usage_count: number; redemptions: number }>(
        `SELECT d.usage_count,
                (SELECT count(*)::int FROM discount_redemptions r WHERE r.discount_id = d.id)
                  AS redemptions
           FROM discounts d WHERE d.id = $1`,
        [discount.id],
      )
      expect(row).toMatchObject({ usage_count: 1, redemptions: 1 })
    })

    it('rolls the whole order back when the code is lost', async () => {
      // The redemption happens inside the checkout transaction, so a customer
      // who loses the race gets no order at all rather than one at full price
      // they did not agree to.
      const product = await sellableProduct(app, owner.accessToken, { quantity: 50 })
      const variantId = product.variants[0]!.id
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'fixed_amount',
        value: 500,
        usageLimitTotal: 1,
      })

      const baskets = await Promise.all(Array.from({ length: 3 }, () => basket(variantId)))
      const results = await Promise.all(
        baskets.map((shopper, i) =>
          checkout(shopper, {
            shippingMethodId: methodId,
            discountCode: discount.code,
            email: `d${i}@example.test`,
          }),
        ),
      )

      expect(results.filter((r) => r.status === 201)).toHaveLength(1)
      const orders = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM orders`)
      expect(orders?.count).toBe(1)

      // And no stock is held by the two orders that never existed.
      const level = await queryOne<{ reserved: number }>(
        `SELECT l.reserved FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [variantId],
      )
      expect(level?.reserved).toBe(1)
    })

    it('honours a per-customer limit under a simultaneous double-submit', async () => {
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken, { quantity: 50 })
      const variantId = product.variants[0]!.id
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'fixed_amount',
        value: 500,
        requiresCustomer: true,
        usageLimitPerCustomer: 1,
        usageLimitTotal: 10,
      })

      const [a, b] = await Promise.all([basket(variantId), basket(variantId)])
      const results = await Promise.all([
        checkout(a, {
          shippingMethodId: methodId,
          discountCode: discount.code,
          token: customer.accessToken,
        }),
        checkout(b, {
          shippingMethodId: methodId,
          discountCode: discount.code,
          token: customer.accessToken,
        }),
      ])

      // A signed-in customer has one active cart, so at most one of these can
      // even reach checkout with a basket — and the code is used at most once
      // either way.
      const redemptions = await query<{ id: string }>(
        `SELECT id FROM discount_redemptions WHERE discount_id = $1 AND customer_id = $2`,
        [discount.id, customer.user.id],
      )
      expect(redemptions.length).toBeLessThanOrEqual(1)
      expect(results.filter((r) => r.status === 201).length).toBeLessThanOrEqual(2)
    })
  })

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('produces one order for a replayed request, not two', async () => {
    // A double-tapped "Pay" button, or a retry after a dropped connection.
    const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
    const shopper = await basket(product.variants[0]!.id)
    const key = '00000000-0000-4000-c000-000000000001'

    const send = () =>
      shopper
        .post('/api/v1/storefront/checkout')
        .set('Idempotency-Key', key)
        .send({
          email: 'buyer@example.test',
          paymentMethod: 'cod',
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            line1: '1 Analytical Way',
            city: 'London',
            countryCode: 'GB',
          },
          shippingMethodId: methodId,
        })

    const first = await send()
    expect(first.status).toBe(201)
    const second = await send()

    const orders = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM orders`)
    expect(orders?.count).toBe(1)
    // The replay is answered, not re-executed.
    expect([200, 201, 409]).toContain(second.status)
  })
})
