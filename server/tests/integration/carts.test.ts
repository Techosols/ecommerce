/**
 * The cart (§5.11).
 *
 * A cart stores *what* and *how many*, never *how much*. Prices are resolved
 * from the catalogue on every read, so a basket left open for three days shows
 * today's price and a client can never quote one.
 *
 * The other thing under test here is identity. There is one cart route shape —
 * `/cart` — and never `/carts/:id`, because a cart id in a URL is a way to
 * reach somebody else's basket. The caller is identified by their session or by
 * a hashed guest cookie, and nothing else.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { addToCart, guest, sellableProduct } from '../factories/commerce.js'
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

describeIfDatabase('cart', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Lines ─────────────────────────────────────────────────────────────────

  describe('lines', () => {
    it('gives a first-time visitor an empty cart without creating noise', async () => {
      const res = await guest(app).get('/api/v1/storefront/cart')
      expect(res.status).toBe(200)
      expect(res.body.data.lines).toEqual([])
      expect(res.body.data.totals.subtotal.amount).toBe(0)
    })

    it('adds a line and prices it from the catalogue', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 2500 })
      const shopper = guest(app)

      const res = await addToCart(shopper, product.variants[0]!.id, 2)

      expect(res.status).toBe(201)
      expect(res.body.data.lines).toHaveLength(1)
      expect(res.body.data.lines[0]).toMatchObject({
        quantity: 2,
        unitPrice: { amount: 2500, currency: 'USD' },
        lineTotal: { amount: 5000, currency: 'USD' },
      })
    })

    it('adds to the existing line rather than creating a second one', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const res = await addToCart(shopper, product.variants[0]!.id, 2)

      expect(res.body.data.lines).toHaveLength(1)
      expect(res.body.data.lines[0].quantity).toBe(3)
    })

    it('changes a quantity and removes a line', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const variantId = product.variants[0]!.id
      const shopper = guest(app)
      await addToCart(shopper, variantId, 3)

      const patched = await shopper
        .patch(`/api/v1/storefront/cart/items/${variantId}`)
        .send({ quantity: 1 })
      expect(patched.body.data.lines[0].quantity).toBe(1)

      const removed = await shopper.delete(`/api/v1/storefront/cart/items/${variantId}`)
      expect(removed.body.data.lines).toHaveLength(0)
    })

    it('empties the whole basket on request', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 2)

      const res = await shopper.delete('/api/v1/storefront/cart')
      expect(res.body.data.lines).toHaveLength(0)
    })

    it('refuses a variant that does not exist', async () => {
      const res = await addToCart(guest(app), '00000000-0000-4000-8000-000000000009', 1)
      expect(res.status).toBe(422)
    })

    it('refuses a product that is not published', async () => {
      // Draft products are invisible to the storefront, and a cart is part of
      // the storefront — otherwise a leaked variant id would be buyable.
      const draft = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', bearer(owner.accessToken))
        .send({ title: 'Unreleased', variants: [{ priceAmount: 1000 }] })

      const res = await addToCart(guest(app), draft.body.data.variants[0].id, 1)
      expect(res.status).toBe(422)
    })
  })

  // ── Prices are never stored ───────────────────────────────────────────────

  describe('pricing', () => {
    it('shows the current price, not the price when the item was added', async () => {
      // A cart holds what and how many. Storing the price would let a basket
      // left open overnight quote yesterday's number at checkout.
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 1000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      await request(app)
        .patch(`/api/v1/admin/variants/${product.variants[0]!.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ priceAmount: 1500 })

      const res = await shopper.get('/api/v1/storefront/cart')
      expect(res.body.data.lines[0].unitPrice.amount).toBe(1500)
      expect(res.body.data.totals.subtotal.amount).toBe(1500)
    })

    it('marks a line unpurchasable when it runs out, and says why', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 1 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      await request(app)
        .post('/api/v1/admin/inventory/adjustments')
        .set('Authorization', bearer(owner.accessToken))
        .send({ variantId: product.variants[0]!.id, delta: -1, reason: 'damage' })

      const res = await shopper.get('/api/v1/storefront/cart')
      expect(res.body.data.purchasable).toBe(false)
      expect(res.body.data.lines[0].purchasable).toBe(false)
      // In words a shopper understands, not a status code.
      expect(res.body.data.lines[0].problem).toBeTruthy()
    })

    it('leaves an unpurchasable line out of the subtotal', async () => {
      const ok = await sellableProduct(app, owner.accessToken, { priceAmount: 1000 })
      const gone = await sellableProduct(app, owner.accessToken, {
        priceAmount: 5000,
        quantity: 1,
      })
      const shopper = guest(app)
      await addToCart(shopper, ok.variants[0]!.id, 1)
      await addToCart(shopper, gone.variants[0]!.id, 1)

      await request(app)
        .post('/api/v1/admin/inventory/adjustments')
        .set('Authorization', bearer(owner.accessToken))
        .send({ variantId: gone.variants[0]!.id, delta: -1, reason: 'damage' })

      const res = await shopper.get('/api/v1/storefront/cart')
      // Charging for something that cannot be sent is worse than showing zero.
      expect(res.body.data.totals.subtotal.amount).toBe(1000)
    })
  })

  // ── Identity ──────────────────────────────────────────────────────────────

  describe('whose cart it is', () => {
    it('keeps two guest baskets apart', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const a = guest(app)
      const b = guest(app)
      await addToCart(a, product.variants[0]!.id, 2)

      const theirs = await b.get('/api/v1/storefront/cart')
      expect(theirs.body.data.lines).toHaveLength(0)
    })

    it('stores only a hash of the guest token', async () => {
      // The cookie is a bearer credential for a basket, so a leaked database
      // must not yield working cart identifiers (§6.2).
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const row = await queryOne<{ anonymous_token_hash: Buffer | null }>(
        `SELECT anonymous_token_hash FROM carts LIMIT 1`,
      )
      expect(row?.anonymous_token_hash).toBeInstanceOf(Buffer)
      expect(row!.anonymous_token_hash!.length).toBe(32)
    })

    it('merges a guest basket into the customer’s on sign-in', async () => {
      // Someone who put two things in before logging in expects to still have
      // them afterwards.
      const product = await sellableProduct(app, owner.accessToken)
      const customer = await createUserAndLogin(app)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 2)

      const merged = await shopper
        .get('/api/v1/storefront/cart')
        .set('Authorization', bearer(customer.accessToken))

      expect(merged.body.data.lines).toHaveLength(1)
      expect(merged.body.data.lines[0].quantity).toBe(2)
    })

    it('gives a signed-in customer one cart, not one per device', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const customer = await createUserAndLogin(app)

      const laptop = guest(app)
      await laptop
        .post('/api/v1/storefront/cart/items')
        .set('Authorization', bearer(customer.accessToken))
        .send({ variantId: product.variants[0]!.id, quantity: 1 })

      const phone = guest(app)
      const res = await phone
        .get('/api/v1/storefront/cart')
        .set('Authorization', bearer(customer.accessToken))

      // A partial unique index enforces one active cart per customer, so two
      // tabs cannot diverge into two baskets.
      expect(res.body.data.lines).toHaveLength(1)
    })
  })
})
