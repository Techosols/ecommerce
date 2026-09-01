/**
 * Cash on delivery, end to end (§5.7).
 *
 * COD is not "a card payment that is late". The money arrives *after* the goods
 * do, and that one fact changes four behaviours — confirmation, the surcharge,
 * the abandoned-order sweep, and what an unpaid order means. This suite walks
 * the real sequence:
 *
 *   place (unpaid) → shop accepts (stock committed) → ship → deliver →
 *   courier returns with the cash → paid
 *
 * and then pins each of the ways it is allowed to be refused.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createShippingMethod,
  guest,
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

describeIfDatabase('cash on delivery', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const post = (path: string, body: object = {}) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', `00000000-0000-4000-8000-${Date.now().toString().slice(-12)}`)
      .send(body)

  /** Places a COD order for one unit and returns its id. */
  async function placeCod(options: { priceAmount?: number; quantity?: number } = {}) {
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: options.priceAmount ?? 5000,
      quantity: options.quantity ?? 10,
    })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const res = await checkout(shopper, { paymentMethod: 'cod', shippingMethodId: methodId })
    if (res.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(res.body)}`)
    return { orderId: res.body.data.id as string, product, body: res.body.data }
  }

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

  // ── The happy path ────────────────────────────────────────────────────────

  it('places an unpaid order that records how it will be paid', async () => {
    const { body } = await placeCod()

    expect(body.paymentMethod).toBe('cod')
    // Unpaid, and that is correct rather than a problem to be fixed.
    expect(body.status).toBe('pending')
    const row = await queryOne<{ payment_status: string }>(
      `SELECT payment_status FROM orders WHERE id = $1`,
      [body.id],
    )
    expect(row?.payment_status).toBe('pending')
  })

  it('adds the handling fee to the total, kept separate from shipping', async () => {
    await setSettings({ codFeeCents: 250 })
    const { body } = await placeCod({ priceAmount: 5000 })

    expect(body.totals.paymentFee).toEqual({ amount: 250, currency: 'USD' })
    // 5000 + 499 shipping + 250 handling. The database's own CHECK enforces
    // that these add up, so an order that got here is arithmetically sound.
    expect(body.totals.total.amount).toBe(5749)
  })

  it('commits the stock when the shop accepts the order, without any payment', async () => {
    const { orderId, product } = await placeCod()
    const variantId = product.variants[0]!.id

    const held = await get(`/admin/inventory/variants/${variantId}`)
    expect(held.body.data.levels[0]).toMatchObject({ onHand: 10, reserved: 1, available: 9 })

    const confirmed = await post(`/admin/orders/${orderId}/confirm`)

    expect(confirmed.status).toBe(200)
    expect(confirmed.body.data.status).toBe('confirmed')
    // Still unpaid — accepting a COD order is a decision to ship, not a receipt.
    expect(confirmed.body.data.paymentStatus).toBe('pending')

    const committed = await get(`/admin/inventory/variants/${variantId}`)
    // The unit has left the shelf: on_hand fell, the hold is gone.
    expect(committed.body.data.levels[0]).toMatchObject({ onHand: 9, reserved: 0, available: 9 })
  })

  it('records the collection when the courier comes back, without repeating the method', async () => {
    const { orderId } = await placeCod()
    await post(`/admin/orders/${orderId}/confirm`)

    // An empty body: the order already knows it is COD, and repeating it is a
    // chance to record it wrongly.
    const payment = await post(`/admin/orders/${orderId}/payments`, {})

    expect(payment.status).toBe(201)
    expect(payment.body.data).toMatchObject({ method: 'cod', status: 'paid' })
    expect(payment.body.data.amount.amount).toBe(5499)

    const after = await get(`/admin/orders/${orderId}`)
    expect(after.body.data.paymentStatus).toBe('paid')
  })

  it('collects exactly the outstanding balance, never an amount from the request', async () => {
    await setSettings({ codFeeCents: 100 })
    const { orderId } = await placeCod({ priceAmount: 2000 })
    await post(`/admin/orders/${orderId}/confirm`)

    const payment = await post(`/admin/orders/${orderId}/payments`, {})
    // 2000 + 499 + 100, computed from the order.
    expect(payment.body.data.amount.amount).toBe(2599)
  })

  it('refuses to take more than is owed', async () => {
    const { orderId } = await placeCod()
    const res = await post(`/admin/orders/${orderId}/payments`, { amountCents: 999_999 })
    expect(res.status).toBe(422)
    expect(res.body.message).toMatch(/outstanding balance/i)
  })

  it('refuses a payment against a cancelled order', async () => {
    const { orderId } = await placeCod()
    await post(`/admin/orders/${orderId}/cancel`, { reason: 'Customer changed their mind' })

    const res = await post(`/admin/orders/${orderId}/payments`, {})
    expect(res.status).toBe(422)
    expect(res.body.message).toMatch(/cancelled order/i)
  })

  // ── Confirmation is idempotent ────────────────────────────────────────────

  it('does not double-count a customer when confirmed twice', async () => {
    // Confirmation is reached from three directions — a payment landing, staff
    // accepting, and the generic transition endpoint — so it must be safe to
    // arrive twice. Re-recording would inflate lifetime spend.
    const customer = await createUserAndLogin(app)
    const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const placed = await checkout(shopper, {
      paymentMethod: 'cod',
      shippingMethodId: methodId,
      token: customer.accessToken,
    })

    await post(`/admin/orders/${placed.body.data.id}/confirm`)
    await post(`/admin/orders/${placed.body.data.id}/confirm`)

    const row = await queryOne<{ orders_count: number; total_spent_cents: string }>(
      `SELECT orders_count, total_spent_cents FROM users WHERE id = $1`,
      [customer.user.id],
    )
    expect(row?.orders_count).toBe(1)
    expect(Number(row?.total_spent_cents)).toBe(5499)
  })

  it('commits the stock exactly once across repeated confirmations', async () => {
    const { orderId, product } = await placeCod()
    await post(`/admin/orders/${orderId}/confirm`)
    await post(`/admin/orders/${orderId}/confirm`)

    const level = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)
    expect(level.body.data.levels[0]).toMatchObject({ onHand: 9, reserved: 0 })
  })

  it('commits the stock when confirmed through the generic transition endpoint', async () => {
    // The bug this guards: a status move to `confirmed` that skips `confirm()`
    // leaves the stock held but never taken, and the customer's lifetime
    // figures untouched.
    const { orderId, product } = await placeCod()

    await post(`/admin/orders/${orderId}/transitions`, { field: 'status', to: 'confirmed' })

    const level = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)
    expect(level.body.data.levels[0]).toMatchObject({ onHand: 9, reserved: 0 })
  })

  // ── Eligibility, over HTTP ────────────────────────────────────────────────

  describe('when COD is refused', () => {
    async function attempt(overrides: { address?: Record<string, unknown>; token?: string } = {}) {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      return checkout(shopper, {
        paymentMethod: 'cod',
        shippingMethodId: methodId,
        ...overrides,
      })
    }

    it('is refused when the store has switched it off', async () => {
      await setSettings({ codEnabled: false })
      const res = await attempt()
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE')
    })

    it('is refused above the ceiling, and says why', async () => {
      await setSettings({ codMaxSubtotalCents: 1000 })
      const res = await attempt()
      expect(res.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE')
      // The specific reason, not "unavailable" — one is actionable.
      expect(res.body.message).toMatch(/above the maximum/i)
    })

    it('is refused below the floor', async () => {
      await setSettings({ codMinSubtotalCents: 100_000 })
      const res = await attempt()
      expect(res.body.message).toMatch(/below the minimum/i)
    })

    it('is refused outside the country whitelist', async () => {
      // The GB zone from `beforeEach` is the one that matters here; a second
      // one would now be refused as an overlap, and was never needed — the
      // address is GB either way.
      await setSettings({ codCountryCodes: ['FR'] })
      const res = await attempt()
      expect(res.body.message).toMatch(/delivery address/i)
    })

    it('can be restricted to account holders', async () => {
      await setSettings({ codRequiresAccount: true })
      const asGuest = await attempt()
      expect(asGuest.body.message).toMatch(/sign in/i)

      const customer = await createUserAndLogin(app)
      const asCustomer = await attempt({ token: customer.accessToken })
      expect(asCustomer.status).toBe(201)
    })

    it('caps how many unpaid COD orders one customer may hold', async () => {
      await setSettings({ codMaxOpenOrders: 1 })
      const customer = await createUserAndLogin(app)

      const first = await attempt({ token: customer.accessToken })
      expect(first.status).toBe(201)

      const second = await attempt({ token: customer.accessToken })
      expect(second.status).toBe(422)
      expect(second.body.message).toMatch(/maximum number of unpaid/i)
    })

    it('frees a slot once the cash is collected', async () => {
      await setSettings({ codMaxOpenOrders: 1 })
      const customer = await createUserAndLogin(app)
      const first = await attempt({ token: customer.accessToken })

      await post(`/admin/orders/${first.body.data.id}/confirm`)
      await post(`/admin/orders/${first.body.data.id}/payments`, {})

      // The first order is paid, so it no longer counts against the cap.
      const second = await attempt({ token: customer.accessToken })
      expect(second.status).toBe(201)
    })

    it('will not let a customer name the staff-only method', async () => {
      // `manual` is how staff record money that arrived some other way.
      // Offering it here would be a "mark my own order paid" button, so it is
      // refused by the schema before any service sees it.
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        paymentMethod: 'manual',
        shippingMethodId: methodId,
      })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('will not accept a method that does not exist', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        paymentMethod: 'bitcoin',
        shippingMethodId: methodId,
      })
      expect(res.status).toBe(422)
    })
  })

  // ── What the storefront is offered ────────────────────────────────────────

  describe('the offer on the checkout page', () => {
    it('lists COD with its fee', async () => {
      await setSettings({ codFeeCents: 199 })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await shopper.get(
        `/api/v1/storefront/checkout/preview?countryCode=GB&shippingMethodId=${methodId}`,
      )

      expect(res.body.data.paymentMethods).toEqual([
        expect.objectContaining({ key: 'cod', fee: { amount: 199, currency: 'USD' } }),
      ])
      expect(res.body.data.selectedPaymentMethod).toBe('cod')
    })

    it('offers nothing when this basket cannot use COD', async () => {
      // An empty list is the honest answer: showing an option that checkout
      // will refuse is worse than showing none.
      await setSettings({ codMaxSubtotalCents: 100 })
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await shopper.get('/api/v1/storefront/checkout/preview?countryCode=GB')
      expect(res.body.data.paymentMethods).toEqual([])
      expect(res.body.data.selectedPaymentMethod).toBeNull()
    })

    it('does not publish the thresholds themselves', async () => {
      // They are the store's abuse controls; publishing them is publishing
      // exactly what to stay under.
      await setSettings({ codMaxSubtotalCents: 20_000, codMaxOpenOrders: 2 })
      const res = await request(app).get('/api/v1/storefront/settings')

      expect(res.body.data.codEnabled).toBe(true)
      const serialised = JSON.stringify(res.body.data)
      expect(serialised).not.toMatch(/20000/)
      expect(serialised).not.toMatch(/codMax/)
    })
  })

  // ── The whole sequence ────────────────────────────────────────────────────

  it('walks place → accept → ship → deliver → collect', async () => {
    const { orderId } = await placeCod()

    await post(`/admin/orders/${orderId}/confirm`)

    const detail = await get(`/admin/orders/${orderId}`)
    const itemId = detail.body.data.items[0].id
    const shipment = await post(`/admin/orders/${orderId}/shipments`, {
      items: [{ orderItemId: itemId, quantity: 1 }],
      carrier: 'Royal Mail',
    })
    await post(`/admin/shipments/${shipment.body.data.id}/status`, { status: 'delivered' })

    const delivered = await get(`/admin/orders/${orderId}`)
    expect(delivered.body.data.displayStatus).toBe('delivered')
    // Delivered but not yet paid: the courier has not handed the money over.
    expect(delivered.body.data.paymentStatus).toBe('pending')

    await post(`/admin/orders/${orderId}/payments`, {})

    const settled = await get(`/admin/orders/${orderId}`)
    expect(settled.body.data.paymentStatus).toBe('paid')
    expect(settled.body.data.displayStatus).toBe('delivered')
  })
})
