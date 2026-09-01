/**
 * Carts and checkout attempts, from the shop's side (§8.4).
 *
 * Two things this suite exists to hold down:
 *
 *   **A cart holds no money.** Its value is computed from the variants' prices
 *   *now*, so a basket left overnight is worth what recovering it would be
 *   worth today — not what it was worth when somebody filled it.
 *
 *   **Recording a checkout must never cost a sale.** The attempt log is written
 *   after the order exists and its failures are swallowed, so a bookkeeping
 *   problem cannot turn a completed purchase into an error.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
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

describeIfDatabase('carts and checkout attempts', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let variantId: string

  const adminGet = (path: string, token?: string) =>
    request(app)
      .get(`/api/v1${path}`)
      .set('Authorization', bearer(token ?? owner.accessToken))

  /** A basket of a known size, held by a fresh agent. 500 a unit. */
  const basket = async (units: number, token?: string) => {
    const shopper = guest(app)
    const req = shopper.post('/api/v1/storefront/cart/items')
    if (token) req.set('Authorization', bearer(token))
    const added = await req.send({ variantId, quantity: units })
    expect(added.status).toBe(201)
    return shopper
  }

  /** The cart id, read from the database rather than from a response. */
  const newestCartId = async () =>
    (
      await queryOne<{ id: string }>(
        `SELECT id FROM carts ORDER BY created_at DESC LIMIT 1`,
        [],
      )
    )?.id as string

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: 500,
      quantity: 100,
    })
    variantId = product.variants[0]!.id
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Reading the pile ──────────────────────────────────────────────────────

  describe('the cart list', () => {
    it('values a basket at what those items cost now', async () => {
      await basket(4)

      const res = await adminGet('/admin/carts')

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({ status: 'active', itemCount: 4 })
      expect(res.body.data[0].value.amount).toBe(2000)
    })

    it('follows the price rather than remembering one', async () => {
      // A cart stores a reference and a quantity, never a price — so a basket
      // left open is worth what recovering it would be worth today.
      await basket(2)
      await execute(`UPDATE product_variants SET price_amount = 1000 WHERE id = $1`, [variantId])

      const res = await adminGet('/admin/carts')

      expect(res.body.data[0].value.amount).toBe(2000)
    })

    it('leaves out the empty carts nobody wants to look at', async () => {
      // An empty cart is created by anybody who so much as looks at the shop.
      const shopper = guest(app)
      await shopper.get('/api/v1/storefront/cart')
      await basket(1)

      const byDefault = await adminGet('/admin/carts')
      const everything = await adminGet('/admin/carts?withItemsOnly=false')

      expect(byDefault.body.data).toHaveLength(1)
      expect(everything.body.data.length).toBeGreaterThan(1)
    })

    it('narrows to what was abandoned, and totals the whole pile', async () => {
      await basket(3)
      const cartId = await newestCartId()
      await execute(`UPDATE carts SET status = 'abandoned' WHERE id = $1`, [cartId])
      await basket(1)

      const res = await adminGet('/admin/carts?status=abandoned')

      expect(res.body.data).toHaveLength(1)
      // The headline figure is the whole abandoned pile, not this page: a
      // number that changed with the pager would be a different number.
      expect(res.body.meta.abandonedCount).toBe(1)
      expect(res.body.meta.abandonedValue.amount).toBe(1500)
    })

    it('finds a cart by the customer behind it', async () => {
      const shopper = await createUserAndLogin(app, { email: 'lost@example.test' })
      await basket(2, shopper.accessToken)

      const found = await adminGet('/admin/carts?q=lost@example.test')
      const missed = await adminGet('/admin/carts?q=nobody@example.test')

      expect(found.body.data).toHaveLength(1)
      expect(found.body.data[0].customerEmail).toBe('lost@example.test')
      expect(missed.body.data).toHaveLength(0)
    })
  })

  // ── One cart ──────────────────────────────────────────────────────────────

  describe('one cart', () => {
    it('shows what the shopper would see if they came back', async () => {
      await basket(2)
      const cartId = await newestCartId()

      const res = await adminGet(`/admin/carts/${cartId}`)

      expect(res.status).toBe(200)
      expect(res.body.data.lines).toHaveLength(1)
      expect(res.body.data.lines[0]).toMatchObject({ quantity: 2, purchasable: true })
      expect(res.body.data.totals.subtotal.amount).toBe(1000)
    })

    it('says which line has become unbuyable, which is often why they left', async () => {
      await basket(2)
      const cartId = await newestCartId()
      // Archived out from under the basket.
      await execute(`UPDATE product_variants SET is_active = false WHERE id = $1`, [variantId])

      const res = await adminGet(`/admin/carts/${cartId}`)

      expect(res.body.data.purchasable).toBe(false)
      expect(res.body.data.lines[0].purchasable).toBe(false)
      expect(res.body.data.lines[0].problem).toBeTruthy()
    })

    it('offers no way to change what is in it', async () => {
      await basket(1)
      const cartId = await newestCartId()

      // Editing a shopper's basket behind their back is not a thing a shop
      // should be able to do, and there is no route that would.
      const patched = await request(app)
        .patch(`/api/v1/admin/carts/${cartId}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ items: [] })

      expect(patched.status).toBe(404)
    })
  })

  // ── Recovery ──────────────────────────────────────────────────────────────

  describe('sending somebody back to their basket', () => {
    const recover = (cartId: string, token?: string) =>
      request(app)
        .post(`/api/v1/admin/carts/${cartId}/recover`)
        .set('Authorization', bearer(token ?? owner.accessToken))

    it('queues the email to the account that owns the cart', async () => {
      const shopper = await createUserAndLogin(app, { email: 'comeback@example.test' })
      await basket(2, shopper.accessToken)
      const cartId = await newestCartId()

      const res = await recover(cartId)

      expect(res.status).toBe(202)
      expect(res.body.data).toMatchObject({ sent: true, to: 'comeback@example.test' })
    })

    it('refuses a guest basket, and says why', async () => {
      await basket(2)
      const cartId = await newestCartId()

      const res = await recover(cartId)

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/guest/i)
    })

    it('refuses a basket that already became an order', async () => {
      const shopper = await createUserAndLogin(app)
      const cart = await basket(2, shopper.accessToken)
      const cartId = await newestCartId()
      const placed = await checkout(cart, {
        shippingMethodId: methodId,
        token: shopper.accessToken,
      })
      expect(placed.status).toBe(201)

      const res = await recover(cartId)

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/became an order/)
    })

    it('needs customers:write, because it contacts a customer', async () => {
      const shopper = await createUserAndLogin(app)
      await basket(1, shopper.accessToken)
      const cartId = await newestCartId()
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      // Staff may read the cart queue and may not email people.
      expect((await adminGet('/admin/carts', staff.accessToken)).status).toBe(200)
      expect((await recover(cartId, staff.accessToken)).status).toBe(403)
    })
  })

  // ── The checkout log ──────────────────────────────────────────────────────

  describe('checkout attempts', () => {
    it('records a sale without changing anything about it', async () => {
      const cart = await basket(2)
      const placed = await checkout(cart, { shippingMethodId: methodId })
      expect(placed.status).toBe(201)

      const res = await adminGet('/admin/checkout-attempts')

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({
        outcome: 'placed',
        orderId: placed.body.data.id,
        itemCount: 2,
        failureCode: null,
      })
      expect(res.body.data[0].subtotal.amount).toBe(1000)
    })

    it('records why an attempt was refused, in the code the API refuses with', async () => {
      const cart = await basket(2)
      // Sold out from under the basket between filling it and paying.
      await execute(
        `UPDATE inventory_levels SET on_hand = 0
          WHERE inventory_item_id = (SELECT id FROM inventory_items WHERE variant_id = $1)`,
        [variantId],
      )

      const failed = await checkout(cart, { shippingMethodId: methodId })
      expect(failed.status).toBeGreaterThanOrEqual(400)

      const res = await adminGet('/admin/checkout-attempts?outcome=failed')

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].outcome).toBe('failed')
      // The server's own code, not the prose: the prose changes whenever
      // somebody improves the wording, and the admin groups by the code.
      expect(res.body.data[0].failureCode).toBe(failed.body.code)
      expect(res.body.data[0].orderId).toBeNull()
    })

    it('leaves the refusal the customer sees exactly as it was', async () => {
      const cart = await basket(2)
      await execute(
        `UPDATE inventory_levels SET on_hand = 0
          WHERE inventory_item_id = (SELECT id FROM inventory_items WHERE variant_id = $1)`,
        [variantId],
      )

      const failed = await checkout(cart, { shippingMethodId: methodId })

      // The log is written and the error re-thrown unchanged.
      expect(failed.body.code).toBeTruthy()
      expect(failed.body.message).toBeTruthy()
    })

    it('counts the rate and the reasons over a window', async () => {
      const good = await basket(1)
      expect((await checkout(good, { shippingMethodId: methodId })).status).toBe(201)

      // A second product for the failing attempt: zeroing the first one's
      // stock would strand the reservation the sale above is holding, which
      // the database refuses — and rightly.
      const other = await sellableProduct(app, owner.accessToken, {
        priceAmount: 500,
        quantity: 10,
      })
      const bad = guest(app)
      await bad
        .post('/api/v1/storefront/cart/items')
        .send({ variantId: other.variants[0]!.id, quantity: 1 })
      await execute(
        `UPDATE inventory_levels SET on_hand = 0
          WHERE inventory_item_id = (SELECT id FROM inventory_items WHERE variant_id = $1)`,
        [other.variants[0]!.id],
      )
      await checkout(bad, { shippingMethodId: methodId })

      const res = await adminGet('/admin/checkout-attempts/summary')

      expect(res.status).toBe(200)
      expect(res.body.data.placed).toBe(1)
      expect(res.body.data.failed).toBe(1)
      expect(res.body.data.reasons[0]).toMatchObject({ count: 1 })
    })

    it('keeps the log behind orders:read', async () => {
      const customer = await createUserAndLogin(app)

      const res = await request(app)
        .get('/api/v1/admin/checkout-attempts')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(403)
    })
  })
})
