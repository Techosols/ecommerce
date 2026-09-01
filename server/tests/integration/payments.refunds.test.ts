/**
 * Refunds (§5.7, §20).
 *
 * Money leaving is the operation with the least room for error, so the guards
 * are in the database rather than in a service: a conditional `UPDATE` that
 * cannot take a payment below zero, and a CHECK that refuses an order refunded
 * for more than it was worth.
 *
 * The concurrency case at the end is the one that matters. Two staff refunding
 * the same payment at the same moment must not together exceed it, and the
 * order's status must end up describing what actually happened.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { getPool } from '../../src/infrastructure/database/pool.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
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

describeIfDatabase('refunds', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let keyCounter = 0

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const post = (path: string, body: object = {}) => {
    keyCounter += 1
    return request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', `00000000-0000-4000-a000-${String(keyCounter).padStart(12, '0')}`)
      .send(body)
  }

  /** A paid order: placed, accepted, and the money recorded. */
  async function paidOrder(priceAmount = 5000, quantity = 1) {
    const product = await sellableProduct(app, owner.accessToken, { priceAmount, quantity: 10 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, quantity)
    const placed = await checkout(shopper, { shippingMethodId: methodId })
    const orderId = placed.body.data.id as string

    await post(`/admin/orders/${orderId}/confirm`)
    const payment = await post(`/admin/orders/${orderId}/payments`, {})
    return {
      orderId,
      product,
      itemId: placed.body.data.items[0].id as string,
      paymentId: payment.body.data.id as string,
      totalCents: placed.body.data.totals.total.amount as number,
    }
  }

  beforeAll(async () => {
    await setupDatabase()
    // Overlapping refunds need overlapping connections, or the race is not one.
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

  it('refunds part of a payment and says so on the order', async () => {
    const { orderId, paymentId } = await paidOrder()

    const res = await post(`/admin/orders/${orderId}/refunds`, {
      paymentId,
      amountCents: 500,
      reason: 'Goodwill',
    })

    expect(res.status).toBe(201)
    expect(res.body.data.amount).toEqual({ amount: 500, currency: 'USD' })

    const after = await get(`/admin/orders/${orderId}`)
    expect(after.body.data.paymentStatus).toBe('partially_refunded')
    expect(after.body.data.totals.refundedTotal.amount).toBe(500)
  })

  it('marks the order fully refunded when the whole total goes back', async () => {
    const { orderId, paymentId, totalCents } = await paidOrder()

    await post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: totalCents })

    const after = await get(`/admin/orders/${orderId}`)
    expect(after.body.data.paymentStatus).toBe('refunded')
  })

  it('refuses to refund more than was captured', async () => {
    const { orderId, paymentId, totalCents } = await paidOrder()

    const res = await post(`/admin/orders/${orderId}/refunds`, {
      paymentId,
      amountCents: totalCents + 1,
    })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REFUND_EXCEEDS_PAYMENT')
  })

  it('refuses a second refund that would take the payment past zero', async () => {
    const { orderId, paymentId, totalCents } = await paidOrder()
    await post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: totalCents - 100 })

    const res = await post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: 200 })
    expect(res.status).toBe(409)
  })

  it('refuses a payment that belongs to a different order', async () => {
    // Refusing rather than 404ing keeps the pair of ids from being used to
    // probe which payments exist.
    const a = await paidOrder()
    const b = await paidOrder()

    const res = await post(`/admin/orders/${a.orderId}/refunds`, {
      paymentId: b.paymentId,
      amountCents: 100,
    })
    expect(res.status).toBe(422)
    expect(res.body.message).toMatch(/does not belong/i)
  })

  it('refuses a zero or negative amount', async () => {
    const { orderId, paymentId } = await paidOrder()
    for (const amountCents of [0, -100]) {
      const res = await post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents })
      expect(res.status).toBe(422)
    }
  })

  it('puts stock back only when asked to', async () => {
    const { orderId, paymentId, product, itemId } = await paidOrder()
    const variantId = product.variants[0]!.id

    const before = await get(`/admin/inventory/variants/${variantId}`)
    expect(before.body.data.levels[0].onHand).toBe(9)

    await post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: 100, restock: false })
    expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(9)

    await post(`/admin/orders/${orderId}/refunds`, {
      paymentId,
      amountCents: 100,
      restock: true,
      items: [{ orderItemId: itemId, quantity: 1 }],
    })
    expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(10)
  })

  it('records a restock as an explicit return, not a bare increase', async () => {
    const { orderId, paymentId, itemId } = await paidOrder()
    await post(`/admin/orders/${orderId}/refunds`, {
      paymentId,
      amountCents: 100,
      restock: true,
      items: [{ orderItemId: itemId, quantity: 1 }],
    })

    const movements = await query<{ reason: string }>(
      `SELECT reason FROM inventory_movements ORDER BY id`,
    )
    expect(movements.map((m) => m.reason)).toContain('return')
  })

  // ── Money and units are different quantities ──────────────────────────────

  describe('what a refund puts back', () => {
    it('returns only the units named, not the whole line', async () => {
      // The bug this replaces: a refund used to restock everything the order
      // still held, so a small goodwill refund on a multi-unit line put every
      // unit back and the shop then sold stock it did not have.
      const { orderId, paymentId, product, itemId } = await paidOrder(5000, 3)
      const variantId = product.variants[0]!.id

      // 10 on the shelf, 3 sold and committed.
      expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(7)

      await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: 5000,
        restock: true,
        items: [{ orderItemId: itemId, quantity: 1 }],
      })

      // One unit back, not three.
      expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(8)
    })

    it('records the units so a second refund cannot return them again', async () => {
      const { orderId, paymentId, product, itemId } = await paidOrder(5000, 2)
      const variantId = product.variants[0]!.id

      await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: 100,
        restock: true,
        items: [{ orderItemId: itemId, quantity: 2 }],
      })
      expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(10)

      const third = await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: 100,
        restock: true,
        items: [{ orderItemId: itemId, quantity: 1 }],
      })
      // Only two were bought, so a third cannot come back.
      expect(third.status).toBe(422)
      expect(third.body.message).toMatch(/more units .* than were ordered/i)
      expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(10)
    })

    it('refuses to restock without saying which units', async () => {
      // `restock: true` alone is ambiguous, and guessing is what caused the
      // original bug. The schema makes it a 422 instead.
      const { orderId, paymentId } = await paidOrder()
      const res = await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: 100,
        restock: true,
      })
      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body.details)).toMatch(/items/)
    })

    it('refuses a line from another order', async () => {
      const a = await paidOrder()
      const b = await paidOrder()

      const res = await post(`/admin/orders/${a.orderId}/refunds`, {
        paymentId: a.paymentId,
        amountCents: 100,
        restock: true,
        items: [{ orderItemId: b.itemId, quantity: 1 }],
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/does not belong/i)
    })

    it('leaves a later cancellation only the units nobody returned', async () => {
      const { orderId, paymentId, product, itemId } = await paidOrder(5000, 3)
      const variantId = product.variants[0]!.id

      await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: 5000,
        restock: true,
        items: [{ orderItemId: itemId, quantity: 1 }],
      })
      await post(`/admin/orders/${orderId}/cancel`, { reason: 'Customer returned the rest' })

      // 7 + 1 refunded + 2 from the cancellation. The refunded unit is not
      // counted twice, which is what `refunded_quantity` is for.
      expect((await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0].onHand).toBe(10)
    })
  })

  it('needs the refund permission, which staff do not hold', async () => {
    const { orderId, paymentId } = await paidOrder()
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    const res = await request(app)
      .post(`/api/v1/admin/orders/${orderId}/refunds`)
      .set('Authorization', bearer(staff.accessToken))
      .set('Idempotency-Key', '00000000-0000-4000-b000-000000000001')
      .send({ paymentId, amountCents: 100 })

    expect(res.status).toBe(403)
  })

  // ── The one that matters ──────────────────────────────────────────────────

  describe('under concurrency', () => {
    it('never lets two simultaneous refunds exceed the payment', async () => {
      const { orderId, paymentId, totalCents } = await paidOrder(10_000)
      // Two refunds for two-thirds each: together they would overdraw it.
      const each = Math.floor((totalCents * 2) / 3)

      const [a, b] = await Promise.all([
        post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: each }),
        post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: each }),
      ])

      const statuses = [a.status, b.status].sort()
      expect(statuses).toEqual([201, 409])

      const payment = await queryOne<{ refunded_cents: number; amount_cents: number }>(
        `SELECT refunded_cents, amount_cents FROM payments WHERE id = $1`,
        [paymentId],
      )
      expect(payment!.refunded_cents).toBe(each)
      expect(payment!.refunded_cents).toBeLessThanOrEqual(payment!.amount_cents)
    })

    it('ends up with a payment status that matches the money', async () => {
      // The bug this guards: both refunds read the order's refunded total
      // *before* either increment, each concludes the order is only partially
      // refunded, and an order that is fully refunded is left saying otherwise.
      const { orderId, paymentId, totalCents } = await paidOrder(10_000)
      const half = Math.floor(totalCents / 2)

      await Promise.all([
        post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: half }),
        post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: totalCents - half }),
      ])

      const order = await queryOne<{ refunded_total_cents: number; payment_status: string }>(
        `SELECT refunded_total_cents, payment_status FROM orders WHERE id = $1`,
        [orderId],
      )
      expect(order!.refunded_total_cents).toBe(totalCents)
      expect(order!.payment_status).toBe('refunded')
    })

    it('keeps the refund ledger and the payment counter in step', async () => {
      const { orderId, paymentId } = await paidOrder(10_000)

      await Promise.all(
        Array.from({ length: 6 }, () =>
          post(`/admin/orders/${orderId}/refunds`, { paymentId, amountCents: 2000 }),
        ),
      )

      const payment = await queryOne<{ refunded_cents: number }>(
        `SELECT refunded_cents FROM payments WHERE id = $1`,
        [paymentId],
      )
      const ledger = await queryOne<{ total: string }>(
        `SELECT coalesce(sum(amount_cents), 0) AS total FROM refunds WHERE payment_id = $1`,
        [paymentId],
      )
      // The denormalised counter and the ledger it summarises must agree, and
      // neither may exceed what was captured (10499 with shipping).
      expect(payment!.refunded_cents).toBe(Number(ledger!.total))
      expect(payment!.refunded_cents).toBeLessThanOrEqual(10_499)
    })
  })
})
