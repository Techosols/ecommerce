/**
 * Checkout (§5.6, CLAUDE.md §16–18).
 *
 * The three things this suite exists to hold down:
 *
 *   **The server computes the money.** No price, total or line amount crosses
 *   the boundary inbound. A request that tries is a 422, not a bargain.
 *
 *   **An order snapshots what was bought.** Renaming or repricing a product
 *   tomorrow must not rewrite what somebody bought today.
 *
 *   **Checkout is one transaction.** Either there is an order with a stock hold
 *   and copied addresses, or there is nothing at all — never a half-placed
 *   order a customer can be charged for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  GB_ADDRESS,
  addToCart,
  checkout,
  createDiscount,
  createShippingMethod,
  guest,
  idempotencyKey,
  sellableProduct,
  setSettings,
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

describeIfDatabase('checkout', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string

  const admin = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))

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

  // ── The money ─────────────────────────────────────────────────────────────

  describe('what the order costs', () => {
    it('computes the total from the catalogue, not from the request', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 2)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      expect(res.status).toBe(201)
      expect(res.body.data.totals).toMatchObject({
        subtotal: { amount: 10_000, currency: 'USD' },
        shippingTotal: { amount: 499, currency: 'USD' },
        total: { amount: 10_499, currency: 'USD' },
      })
    })

    it('refuses a request that carries its own prices', async () => {
      // The strict schema is what closes mass assignment: an unknown key is a
      // 422 rather than a silent drop that leaves the client believing it set
      // something (§16.3).
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await shopper
        .post('/api/v1/storefront/checkout')
        .set('Idempotency-Key', idempotencyKey())
        .send({
          email: 'buyer@example.test',
          paymentMethod: 'cod',
          shippingAddress: GB_ADDRESS,
          shippingMethodId: methodId,
          totalCents: 1,
          subtotalCents: 1,
        })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.details)).toMatch(/totalCents/)
    })

    it('applies tax on top when prices exclude it', async () => {
      await setSettings({ taxRateBps: 2000, pricesIncludeTax: false })
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 1000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      // 1000 subtotal + 20% tax + 499 shipping.
      expect(res.body.data.totals.taxTotal.amount).toBe(200)
      expect(res.body.data.totals.total.amount).toBe(1699)
    })

    it('keeps tax inside the price when prices include it', async () => {
      await setSettings({ taxRateBps: 2000, pricesIncludeTax: true })
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 1200 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      // The tax is already in the 1200, so it is not added again.
      expect(res.body.data.totals.taxTotal.amount).toBe(0)
      expect(res.body.data.totals.total.amount).toBe(1200 + 499)
    })

    it('apportions a discount across lines so the parts equal the whole', async () => {
      // The rounding case: three lines sharing a percentage discount will not
      // divide evenly, and the order's own CHECK constraint refuses a total
      // that is a penny out. The last line absorbs the remainder.
      const a = await sellableProduct(app, owner.accessToken, { priceAmount: 333 })
      const b = await sellableProduct(app, owner.accessToken, { priceAmount: 333 })
      const c = await sellableProduct(app, owner.accessToken, { priceAmount: 334 })
      const discount = await createDiscount(app, owner.accessToken, { type: 'percentage', value: 1000 })

      const shopper = guest(app)
      await addToCart(shopper, a.variants[0]!.id, 1)
      await addToCart(shopper, b.variants[0]!.id, 1)
      await addToCart(shopper, c.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        shippingMethodId: methodId,
        discountCode: discount.code,
      })

      expect(res.status).toBe(201)
      const order = res.body.data
      expect(order.totals.discountTotal.amount).toBe(100) // 10% of 1000

      const lineDiscounts = order.items.reduce(
        (sum: number, item: { discount: { amount: number } }) => sum + item.discount.amount,
        0,
      )
      expect(lineDiscounts).toBe(order.totals.discountTotal.amount)
    })

    it('never lets a discount exceed the subtotal', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 500 })
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'fixed_amount',
        value: 100_000,
      })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        shippingMethodId: methodId,
        discountCode: discount.code,
      })

      expect(res.body.data.totals.discountTotal.amount).toBe(500)
      // Shipping is still owed; a £20 code on a £5 basket is not a refund.
      expect(res.body.data.totals.total.amount).toBe(499)
    })
  })

  // ── The snapshot ──────────────────────────────────────────────────────────

  describe('what the order remembers', () => {
    it('snapshots the title and price, so later edits cannot rewrite history', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, { shippingMethodId: methodId })
      const orderId = placed.body.data.id

      // The shop renames and reprices the product afterwards.
      await request(app)
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ title: 'Renamed Entirely' })
      await request(app)
        .patch(`/api/v1/admin/variants/${product.variants[0]!.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ priceAmount: 9999 })

      const after = await admin(`/admin/orders/${orderId}`)
      expect(after.body.data.items[0]).toMatchObject({
        productTitle: 'Classic Burger',
        unitPrice: { amount: 5000, currency: 'USD' },
      })
      expect(after.body.data.totals.total.amount).toBe(5499)
    })

    it('copies the address rather than pointing at one', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      const shipping = res.body.data.addresses.find(
        (a: { type: string }) => a.type === 'shipping',
      )
      expect(shipping).toMatchObject({ line1: '1 Analytical Way', countryCode: 'GB' })
      // No id: it is a copy, so editing the address book cannot move a parcel
      // that has already been sent.
      expect(shipping.id).toBeUndefined()
    })

    it('bills to the shipping address when no billing address is given', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      const types = res.body.data.addresses.map((a: { type: string }) => a.type).sort()
      expect(types).toEqual(['billing', 'shipping'])
    })
  })

  // ── Who bought it ─────────────────────────────────────────────────────────

  /**
   * A guest checkout produces a customer. The point is that "guest" describes
   * how somebody bought, not whether the shop remembers them: two orders from
   * one email are one person in the Customers list, and every per-customer rule
   * applies to them.
   */
  describe('a guest becomes a customer', () => {
    /** The Customers list is the real surface, so assert through it. */
    const findCustomer = async (email: string) => {
      const res = await admin(`/admin/customers?query=${encodeURIComponent(email)}`)
      return res.body.data.find((row: { email: string }) => row.email === email)
    }

    it('creates a customer record for an email that has never bought here', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: 'first-time@example.test',
      })

      expect(placed.status).toBe(201)
      const customer = await findCustomer('first-time@example.test')
      expect(customer).toBeDefined()
      // Named from the shipping address, which is all a guest told us.
      expect(customer).toMatchObject({ firstName: 'Ada', tags: ['guest'] })
    })

    it('puts the order on that customer rather than leaving it orphaned', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: 'attached@example.test',
      })

      const order = await admin(`/admin/orders/${placed.body.data.id}`)
      const customer = await findCustomer('attached@example.test')
      expect(order.body.data.customerId).toBe(customer.id)
    })

    it('reuses the record on a second order instead of forking a duplicate', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })

      for (const _ of [1, 2]) {
        const shopper = guest(app)
        await addToCart(shopper, product.variants[0]!.id, 1)
        await checkout(shopper, { shippingMethodId: methodId, email: 'repeat@example.test' })
      }

      const res = await admin('/admin/customers?query=repeat@example.test')
      expect(res.body.data).toHaveLength(1)
    })

    it('attaches to an existing account when the shopper did not log in', async () => {
      const registered = await createUserAndLogin(app, { roles: ['customer'] })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      // No Authorization header — a guest checkout, under their email.
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: registered.user.email,
      })

      const order = await admin(`/admin/orders/${placed.body.data.id}`)
      expect(order.body.data.customerId).toBe(registered.user.id)
      // Their own account, not a second one wearing the shop's guest tag.
      const customer = await findCustomer(registered.user.email)
      expect(customer.tags).not.toContain('guest')
    })

    it('leaves the created record unable to be signed into', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId, email: 'nologin@example.test' })

      // The shop made a record of them; it did not make them an account.
      const attempt = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nologin@example.test', password: 'anything-at-all-1234' })
      expect(attempt.status).toBe(401)
    })

    it('does not subscribe them to marketing', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId, email: 'noconsent@example.test' })

      const customer = await findCustomer('noconsent@example.test')
      expect(customer.acceptsMarketing).toBe(false)
    })

    it('records how the record came to exist', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId, email: 'timeline@example.test' })

      const customer = await findCustomer('timeline@example.test')
      const events = await admin(`/admin/customers/${customer.id}/events`)
      expect(events.body.data.map((event: { kind: string }) => event.kind)).toContain(
        'account.created_at_checkout',
      )
    })
  })

  // ── The transaction ───────────────────────────────────────────────────────

  describe('all or nothing', () => {
    it('holds stock for the order it just placed', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 3)

      await checkout(shopper, { shippingMethodId: methodId })

      const level = await admin(`/admin/inventory/variants/${product.variants[0]!.id}`)
      expect(level.body.data.levels[0]).toMatchObject({ onHand: 10, reserved: 3, available: 7 })
    })

    it('leaves nothing behind when a line has run out', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 1 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      // The shelf empties after the basket was filled.
      await request(app)
        .post('/api/v1/admin/inventory/adjustments')
        .set('Authorization', bearer(owner.accessToken))
        .send({ variantId: product.variants[0]!.id, delta: -1, reason: 'damage' })

      const res = await checkout(shopper, { shippingMethodId: methodId })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INSUFFICIENT_STOCK')
      // And no order was written.
      const count = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM orders`)
      expect(count?.count).toBe(0)
    })

    it('names the item that is unavailable', async () => {
      // "Checkout failed" sends a customer back to a page that looks fine.
      const product = await sellableProduct(app, owner.accessToken, { quantity: 1 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await request(app)
        .post('/api/v1/admin/inventory/adjustments')
        .set('Authorization', bearer(owner.accessToken))
        .send({ variantId: product.variants[0]!.id, delta: -1, reason: 'damage' })

      const res = await checkout(shopper, { shippingMethodId: methodId })
      expect(res.body.message).toMatch(/Classic Burger/)
    })

    it('marks the cart converted and clears the guest cookie', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId })

      // The same agent asking for its cart gets a fresh, empty one rather than
      // resuming the basket it just bought.
      const cart = await shopper.get('/api/v1/storefront/cart')
      expect(cart.body.data.lines).toHaveLength(0)
    })

    it('refuses to check out the same cart twice', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId })

      const second = await checkout(shopper, { shippingMethodId: methodId })
      expect(second.status).toBe(422)
    })

    it('refuses an empty checkout', async () => {
      const shopper = guest(app)
      const res = await checkout(shopper, { shippingMethodId: methodId })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/nothing in your cart/i)
    })
  })

  // ── Delivery ──────────────────────────────────────────────────────────────

  describe('delivery', () => {
    it('refuses an address the store does not ship to', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        shippingMethodId: methodId,
        address: { ...GB_ADDRESS, countryCode: 'JP' },
      })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('SHIPPING_UNAVAILABLE')
    })

    it('refuses a delivery option that belongs to another zone', async () => {
      // A method id from a stale page might name a zone that no longer covers
      // the address, so checkout re-rates rather than trusting the id.
      const other = await createShippingMethod(app, owner.accessToken, {
        countryCodes: ['FR'],
        priceCents: 100,
      })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: other.methodId })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('SHIPPING_UNAVAILABLE')
    })

    it('asks for a choice when none was made', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: null })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('NO_SHIPPING_METHOD')
    })
  })

  // ── Who is checking out ───────────────────────────────────────────────────

  describe('guests and customers', () => {
    it('lets a guest buy without an account, and remembers them anyway', async () => {
      // This used to assert `customer_id IS NULL`. It no longer is: checking
      // out without logging in still requires no account, but it no longer
      // means the shop forgets who bought. The guarantee that matters to the
      // shopper — no registration step, no password — is the one below.
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, { shippingMethodId: methodId })

      expect(res.status).toBe(201)
      const row = await queryOne<{ customer_id: string | null }>(
        `SELECT customer_id FROM orders WHERE id = $1`,
        [res.body.data.id],
      )
      expect(row?.customer_id).not.toBeNull()

      // And nothing was set that could be signed into.
      const credentials = await queryOne<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [row!.customer_id],
      )
      expect(credentials?.password_hash).toBeNull()
    })

    it('attaches the order to a signed-in customer', async () => {
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        shippingMethodId: methodId,
        token: customer.accessToken,
      })

      const row = await queryOne<{ customer_id: string | null }>(
        `SELECT customer_id FROM orders WHERE id = $1`,
        [res.body.data.id],
      )
      expect(row?.customer_id).toBe(customer.user.id)
    })

    it('gives each order its own number from the sequence', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 20 })
      const numbers: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const shopper = guest(app)
        await addToCart(shopper, product.variants[0]!.id, 1)
        const res = await checkout(shopper, { shippingMethodId: methodId })
        numbers.push(res.body.data.orderNumber)
      }
      expect(new Set(numbers).size).toBe(3)
      expect(numbers[0]).toMatch(/^#\d+$/)
    })
  })

  // ── Preview ───────────────────────────────────────────────────────────────

  describe('preview', () => {
    it('quotes the same figures checkout will charge', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 2500 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 2)

      const preview = await shopper.get(
        `/api/v1/storefront/checkout/preview?countryCode=GB&shippingMethodId=${methodId}`,
      )
      const placed = await checkout(shopper, { shippingMethodId: methodId })

      expect(preview.body.data.subtotal.amount).toBe(placed.body.data.totals.subtotal.amount)
      expect(preview.body.data.shippingTotal.amount).toBe(
        placed.body.data.totals.shippingTotal.amount,
      )
    })

    it('lists the delivery options for the destination', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await shopper.get('/api/v1/storefront/checkout/preview?countryCode=GB')
      expect(res.body.data.shippingOptions).toHaveLength(1)
      expect(res.body.data.shippingOptions[0].price).toEqual({ amount: 499, currency: 'USD' })
    })

    it('reports a bad discount code before the customer commits', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await shopper.get(
        '/api/v1/storefront/checkout/preview?countryCode=GB&discountCode=NOSUCHCODE',
      )
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_INVALID')
    })
  })
})
