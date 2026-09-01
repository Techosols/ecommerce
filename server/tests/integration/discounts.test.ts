/**
 * Discounts and coupons (§5.9, CLAUDE.md §21).
 *
 * The three things this suite exists to hold down:
 *
 *   **The server computes the money, against a basket the caller does not get
 *   to choose.** A client sends a code and nothing else. If a subtotal could
 *   travel in the request, "what is this worth on a £10,000 basket?" would be
 *   answerable by anyone — and worse, that made-up number would be the one the
 *   discount was computed against.
 *
 *   **Every refusal says which refusal it is.** Expired, not started, minimum
 *   not met, needs an account, used up: five different things a shopper can fix
 *   in five different ways. "Invalid coupon" is the message that generates
 *   support tickets, so each has its own code.
 *
 *   **A limited code is limited.** Redemption increments a counter and writes a
 *   ledger row; cancelling an order that never happened gives the use back. A
 *   hundred-use code that runs out at eighty, or never runs out at all, is money.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { discountsService } from '../../src/features/discounts/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
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

describeIfDatabase('discounts', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let variantId: string

  const adminGet = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))

  /**
   * A basket of a known size, held by a fresh agent.
   *
   * Every check goes through a real cart because the endpoint has no other way
   * to learn a subtotal — which is the point of the endpoint.
   */
  const basket = async (subtotalCents: number, token?: string) => {
    const shopper = guest(app)
    const req = shopper.post('/api/v1/storefront/cart/items')
    if (token) req.set('Authorization', bearer(token))
    const added = await req.send({ variantId, quantity: subtotalCents / 500 })
    expect(added.status).toBe(201)
    return shopper
  }

  /** Asks what a code is worth against the agent's own cart. */
  const check = async (
    shopper: ReturnType<typeof guest>,
    body: Record<string, unknown>,
    token?: string,
  ) => {
    const req = shopper.post('/api/v1/storefront/discounts/check')
    if (token) req.set('Authorization', bearer(token))
    return req.send(body)
  }

  const discountRow = async (id: string) =>
    queryOne<{ id: string; usage_count: number; archived_at: Date | null }>(
      `SELECT id, usage_count, archived_at FROM discounts WHERE id = $1`,
      [id],
    )

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
    // 500 a unit, so a basket of a chosen size is a quantity.
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

  // ── Checking a code ───────────────────────────────────────────────────────

  describe('what a code is worth', () => {
    it('values a code against the basket the caller is actually holding', async () => {
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'percentage',
        value: 1000,
      })
      const shopper = await basket(5000)

      const res = await check(shopper, { code: discount.code })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        code: discount.code,
        type: 'percentage',
        amount: { amount: 500, currency: 'USD' },
        freeShipping: false,
      })
    })

    it('gives the caller no way to name a subtotal of their own', async () => {
      // There is no field for it, and the strict schema turns the attempt into a
      // 422 rather than dropping it — a silent drop would leave a client
      // believing the figure it sent was the one that was used (§16.3).
      const discount = await createDiscount(app, owner.accessToken)
      const shopper = await basket(500)

      const res = await check(shopper, { code: discount.code, subtotalCents: 1_000_000 })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.details)).toMatch(/subtotalCents/)
    })

    it('reads a percentage in basis points, so 1000 is ten per cent', async () => {
      // The unit is the whole reason `value` is a discriminated union: a 25%
      // code that quietly took 25p is the bug this pins down.
      const tenth = await createDiscount(app, owner.accessToken, { type: 'percentage', value: 1000 })
      const quarter = await createDiscount(app, owner.accessToken, {
        type: 'percentage',
        value: 2500,
      })

      const a = await check(await basket(2000), { code: tenth.code })
      const b = await check(await basket(2000), { code: quarter.code })

      expect(a.body.data.amount.amount).toBe(200)
      expect(b.body.data.amount.amount).toBe(500)
    })

    it('never lets a fixed-amount code exceed the subtotal', async () => {
      // A £20 code on a £5 basket takes £5. Anything else is a negative total,
      // which is to say a refund the shop never agreed to.
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'fixed_amount',
        value: 2000,
      })
      const shopper = await basket(500)

      const res = await check(shopper, { code: discount.code })

      expect(res.body.data.amount.amount).toBe(500)
    })

    it('takes nothing off the goods for a free-shipping code, and says so', async () => {
      // The flag is the whole answer: the money comes off delivery, which this
      // endpoint does not price, so an amount of 0 here is correct rather than
      // a code that does nothing.
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'free_shipping',
        value: 0,
      })
      const shopper = await basket(5000)

      const res = await check(shopper, { code: discount.code })

      expect(res.body.data).toMatchObject({
        type: 'free_shipping',
        amount: { amount: 0, currency: 'USD' },
        freeShipping: true,
      })
    })

    it('refuses to check anything for a caller with no cart', async () => {
      const discount = await createDiscount(app, owner.accessToken)

      const res = await check(guest(app), { code: discount.code })

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/nothing in your cart/i)
    })
  })

  // ── Why a code was refused ────────────────────────────────────────────────

  describe('the reason a code was refused', () => {
    it('says invalid for a code that was never issued', async () => {
      const res = await check(await basket(5000), { code: 'NOSUCHCODE' })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_INVALID')
    })

    it('says invalid for a code that has been switched off', async () => {
      // Deliberately the same code as "never issued": telling a caller that
      // SUMMER25 exists but is paused is a code they will try again tomorrow,
      // and it confirms which codes the store has run.
      const discount = await createDiscount(app, owner.accessToken)
      await request(app)
        .patch(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ isActive: false })

      const res = await check(await basket(5000), { code: discount.code })

      expect(res.body.code).toBe('DISCOUNT_INVALID')
    })

    it('says expired for a code whose window has closed', async () => {
      const discount = await createDiscount(app, owner.accessToken, {
        startsAt: new Date(Date.now() - 172_800_000).toISOString(),
        endsAt: new Date(Date.now() - 86_400_000).toISOString(),
      })

      const res = await check(await basket(5000), { code: discount.code })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_EXPIRED')
    })

    it('says expired for a code whose window has not opened yet', async () => {
      // Same code, different message: a scheduled promotion that leaks early is
      // still a promotion the store has not started paying for.
      const discount = await createDiscount(app, owner.accessToken, {
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const res = await check(await basket(5000), { code: discount.code })

      expect(res.body.code).toBe('DISCOUNT_EXPIRED')
      expect(res.body.message).toMatch(/not active yet/i)
    })

    it('says the minimum was not met when the basket is too small', async () => {
      // Distinct from invalid because the shopper can fix it by adding an item,
      // and a storefront that knows this can say so.
      const discount = await createDiscount(app, owner.accessToken, {
        minSubtotalCents: 5000,
      })

      const res = await check(await basket(2500), { code: discount.code })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_MINIMUM_NOT_MET')
    })

    it('says an account is required when the code is for signed-in customers', async () => {
      const discount = await createDiscount(app, owner.accessToken, { requiresCustomer: true })

      const asGuest = await check(await basket(5000), { code: discount.code })

      expect(asGuest.status).toBe(422)
      expect(asGuest.body.code).toBe('DISCOUNT_REQUIRES_ACCOUNT')

      // And the same code works the moment there is somebody to attribute it to.
      const customer = await createUserAndLogin(app)
      const signedIn = await check(
        await basket(5000, customer.accessToken),
        { code: discount.code },
        customer.accessToken,
      )
      expect(signedIn.status).toBe(200)
    })

    it('says the code is used up once its total limit is reached', async () => {
      const discount = await createDiscount(app, owner.accessToken, { usageLimitTotal: 1 })
      const buyer = await basket(5000)
      const placed = await checkout(buyer, { shippingMethodId: methodId, discountCode: discount.code })
      expect(placed.status).toBe(201)

      const res = await check(await basket(5000), { code: discount.code })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_USAGE_EXCEEDED')
    })

    it('refuses the same customer a second use of a once-per-customer code', async () => {
      // Per-customer counting is only possible for somebody with a name, which
      // is why the schema insists on `requiresCustomer` alongside the limit.
      const customer = await createUserAndLogin(app)
      const discount = await createDiscount(app, owner.accessToken, {
        requiresCustomer: true,
        usageLimitPerCustomer: 1,
      })

      const first = await checkout(await basket(5000, customer.accessToken), {
        shippingMethodId: methodId,
        discountCode: discount.code,
        token: customer.accessToken,
      })
      expect(first.status).toBe(201)

      const second = await check(
        await basket(5000, customer.accessToken),
        { code: discount.code },
        customer.accessToken,
      )

      expect(second.status).toBe(422)
      expect(second.body.code).toBe('DISCOUNT_USAGE_EXCEEDED')

      // Somebody else may still use it: the limit is per customer, not total.
      const other = await createUserAndLogin(app)
      const theirs = await check(
        await basket(5000, other.accessToken),
        { code: discount.code },
        other.accessToken,
      )
      expect(theirs.status).toBe(200)
    })
  })

  // ── Redemption ────────────────────────────────────────────────────────────

  describe('spending a use and getting it back', () => {
    it('counts a use when the order is placed, in both the counter and the ledger', async () => {
      // The counter answers "is this used up?" in one indexed read; the ledger
      // is what makes per-customer limits and any later audit possible. They
      // have to agree, so both are asserted.
      const customer = await createUserAndLogin(app)
      const discount = await createDiscount(app, owner.accessToken, { usageLimitTotal: 5 })

      const placed = await checkout(await basket(5000, customer.accessToken), {
        shippingMethodId: methodId,
        discountCode: discount.code,
        token: customer.accessToken,
      })
      expect(placed.status).toBe(201)

      expect((await adminGet(`/admin/discounts/${discount.id}`)).body.data.usageCount).toBe(1)
      const ledger = await query<{ order_id: string; customer_id: string; amount_cents: number }>(
        `SELECT order_id, customer_id, amount_cents FROM discount_redemptions WHERE discount_id = $1`,
        [discount.id],
      )
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({
        order_id: placed.body.data.id,
        customer_id: customer.user.id,
        amount_cents: 500,
      })
    })

    it('gives the use back when the order is cancelled', async () => {
      // The release hangs off the `order.cancelled` subscriber, and this process
      // has no dispatcher running — the test asserts the two halves separately:
      // that cancelling published the event, and that the handler's own call
      // returns the use. Asserting through a dispatch loop here would be
      // testing the outbox, which `events.outbox.test.ts` already owns.
      const discount = await createDiscount(app, owner.accessToken, { usageLimitTotal: 1 })
      const placed = await checkout(await basket(5000), {
        shippingMethodId: methodId,
        discountCode: discount.code,
      })
      const orderId = placed.body.data.id as string
      expect((await discountRow(discount.id))?.usage_count).toBe(1)

      const cancelled = await request(app)
        .post(`/api/v1/admin/orders/${orderId}/cancel`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ reason: 'Customer changed their mind' })
      expect(cancelled.status).toBe(200)

      const events = await query<{ name: string }>(
        `SELECT name FROM domain_events WHERE aggregate_id = $1`,
        [orderId],
      )
      expect(events.map((event) => event.name)).toContain('order.cancelled')

      await discountsService.releaseRedemption(orderId)

      expect((await discountRow(discount.id))?.usage_count).toBe(0)
      const ledger = await query(`SELECT id FROM discount_redemptions WHERE order_id = $1`, [orderId])
      expect(ledger).toHaveLength(0)
      // And the code is spendable again, which is the point of returning it.
      expect((await check(await basket(5000), { code: discount.code })).status).toBe(200)
    })

    it('releases nothing for an order that never carried a code', async () => {
      // Idempotent and indifferent: the subscriber runs on every cancellation,
      // including the overwhelming majority with no discount at all.
      const placed = await checkout(await basket(5000), { shippingMethodId: methodId })

      await expect(
        discountsService.releaseRedemption(placed.body.data.id as string),
      ).resolves.toBeUndefined()
    })
  })

  // ── Administration ────────────────────────────────────────────────────────

  describe('managing the codes', () => {
    it('creates a code with its terms and no uses spent', async () => {
      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({
          code: 'SUMMER25',
          title: 'Summer sale',
          type: 'percentage',
          value: 2500,
          minSubtotalCents: 1000,
          usageLimitTotal: 100,
        })

      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({
        code: 'SUMMER25',
        title: 'Summer sale',
        type: 'percentage',
        value: 2500,
        minSubtotalCents: 1000,
        usageLimitTotal: 100,
        usageCount: 0,
        isActive: true,
        archivedAt: null,
      })
      expect(res.headers.location).toBe(`/api/v1/admin/discounts/${res.body.data.id}`)
    })

    it('refuses a second code with the same word', async () => {
      await createDiscount(app, owner.accessToken, { code: 'TWICE' })

      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({ code: 'TWICE', title: 'Again', type: 'percentage', value: 500 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('ALREADY_EXISTS')
    })

    it('lists the codes with the count a manager wants to see', async () => {
      const discount = await createDiscount(app, owner.accessToken, { usageLimitTotal: 3 })

      const res = await adminGet('/admin/discounts')

      expect(res.status).toBe(200)
      expect(res.body.meta.pagination).toMatchObject({ total: 1, page: 1 })
      expect(res.body.data[0]).toMatchObject({
        id: discount.id,
        usageCount: 0,
        usageLimitTotal: 3,
      })
    })

    it('fetches one code by id', async () => {
      const discount = await createDiscount(app, owner.accessToken)

      const res = await adminGet(`/admin/discounts/${discount.id}`)

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ id: discount.id, code: discount.code })
    })

    it('changes the terms, and the next check uses the new ones', async () => {
      const discount = await createDiscount(app, owner.accessToken, { value: 1000 })

      const patched = await request(app)
        .patch(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ title: 'Now twenty per cent', value: 2000, minSubtotalCents: 1000 })

      expect(patched.status).toBe(200)
      expect(patched.body.data).toMatchObject({ title: 'Now twenty per cent', value: 2000 })
      const res = await check(await basket(5000), { code: discount.code })
      expect(res.body.data.amount.amount).toBe(1000)
    })

    it('archives a deleted code rather than destroying the row', async () => {
      // `order_discounts` records the code and its terms as they were. Deleting
      // the row would leave past orders citing a discount nobody can look up.
      const discount = await createDiscount(app, owner.accessToken)

      const res = await request(app)
        .delete(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))
      expect(res.status).toBe(204)

      const row = await discountRow(discount.id)
      expect(row?.id).toBe(discount.id)
      expect(row?.archived_at).not.toBeNull()

      // Gone from the listing, and no longer spendable.
      expect((await adminGet('/admin/discounts')).body.data).toEqual([])
      const attempt = await check(await basket(5000), { code: discount.code })
      expect(attempt.body.code).toBe('DISCOUNT_INVALID')
    })

    it('refuses a checkout that quotes an archived code', async () => {
      const discount = await createDiscount(app, owner.accessToken)
      await request(app)
        .delete(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))

      const res = await checkout(await basket(5000), {
        shippingMethodId: methodId,
        discountCode: discount.code,
      })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('DISCOUNT_INVALID')
    })
  })

  // ── Who may issue money-off ───────────────────────────────────────────────

  describe('who may issue money-off', () => {
    it('keeps staff out of the discounts, because money-off is a commercial decision', async () => {
      // Staff hold orders, shipping and inventory but deliberately neither
      // discounts:read nor discounts:write (§6.5). Somebody who can create a
      // code can hand out the shop's margin.
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const read = await request(app)
        .get('/api/v1/admin/discounts')
        .set('Authorization', bearer(staff.accessToken))
      const write = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(staff.accessToken))
        .send({ code: 'STAFFPERK', title: 'Mine', type: 'percentage', value: 5000 })

      expect(read.status).toBe(403)
      expect(read.body.code).toBe('INSUFFICIENT_PERMISSIONS')
      expect(write.status).toBe(403)
      expect(write.body.code).toBe('INSUFFICIENT_PERMISSIONS')
    })

    it('lets an admin manage them', async () => {
      const admin = await createUserAndLogin(app, { roles: ['admin'] })

      const res = await request(app)
        .get('/api/v1/admin/discounts')
        .set('Authorization', bearer(admin.accessToken))

      expect(res.status).toBe(200)
    })

    it('keeps a customer off the administration surface entirely', async () => {
      const customer = await createUserAndLogin(app)

      const res = await request(app)
        .get('/api/v1/admin/discounts')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('has no storefront route that lists the live codes', async () => {
      // A code that can be enumerated is not a code — it is a public price list.
      await createDiscount(app, owner.accessToken)

      expect((await request(app).get('/api/v1/storefront/discounts')).status).toBe(404)
    })
  })

  // ── Validation ────────────────────────────────────────────────────────────

  describe('what the schema refuses', () => {
    it('refuses a percentage above one hundred per cent', async () => {
      // 10_000 basis points is the whole basket; more than that is a code that
      // pays the customer to shop.
      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({ code: 'TOOMUCH', title: 'Over a hundred', type: 'percentage', value: 10_001 })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.details)).toMatch(/value/)
    })

    it('refuses a per-customer limit on a code guests may use', async () => {
      // There is nobody to count against, so the limit would read as enforced
      // and be unenforceable — the worst of both.
      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({
          code: 'ONCEEACH',
          title: 'Once each',
          type: 'percentage',
          value: 1000,
          usageLimitPerCustomer: 1,
        })

      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body.details)).toMatch(/usageLimitPerCustomer/)
    })

    it('refuses a window that ends before it starts', async () => {
      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({
          code: 'BACKWARDS',
          title: 'Backwards',
          type: 'percentage',
          value: 1000,
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() - 86_400_000).toISOString(),
        })

      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body.details)).toMatch(/endsAt/)
    })

    it('will not let a live code be retyped or renamed', async () => {
      // An order that cites SUMMER25 as a percentage discount must keep meaning
      // that. Changing either is a new code, not an edit — so both are unknown
      // fields on the patch schema rather than silently ignored ones.
      const discount = await createDiscount(app, owner.accessToken)

      const renamed = await request(app)
        .patch(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ code: 'DIFFERENT' })
      const retyped = await request(app)
        .patch(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ type: 'fixed_amount' })

      expect(renamed.status).toBe(422)
      expect(JSON.stringify(renamed.body.details)).toMatch(/code/)
      expect(retyped.status).toBe(422)
      expect((await discountRow(discount.id))?.id).toBe(discount.id)
      expect((await adminGet(`/admin/discounts/${discount.id}`)).body.data.code).toBe(discount.code)
    })

    it('refuses a code with punctuation a customer cannot type from a poster', async () => {
      const res = await request(app)
        .post('/api/v1/admin/discounts')
        .set('Authorization', bearer(owner.accessToken))
        .send({ code: 'SPRING 25%', title: 'Spring', type: 'percentage', value: 1000 })

      expect(res.status).toBe(422)
    })
  })

  // ── Scope, status and the ledger ──────────────────────────────────────────

  describe('what the console can see', () => {
    const patch = (id: string, body: Record<string, unknown>) =>
      request(app)
        .patch(`/api/v1/admin/discounts/${id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send(body)

    it('returns the scope it was created with, so an edit screen can show it', async () => {
      // Scope used to be write-only: accepted on create, stored, used by the
      // pricing, and never readable — so "10% off coffee" could be created and
      // then never inspected or corrected.
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 500 })
      const discount = await createDiscount(app, owner.accessToken, {
        appliesTo: 'products',
        productIds: [product.id],
      })

      const res = await adminGet(`/admin/discounts/${discount.id}`)

      expect(res.body.data.appliesTo).toBe('products')
      expect(res.body.data.productIds).toEqual([product.id])
      expect(res.body.data.categoryIds).toEqual([])
    })

    it('keeps the scope off the list, which does not need it', async () => {
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 500 })
      await createDiscount(app, owner.accessToken, {
        appliesTo: 'products',
        productIds: [product.id],
      })

      const row = (await adminGet('/admin/discounts')).body.data[0]

      expect(row.productIds).toBeUndefined()
    })

    it('replaces the scope wholesale, and the pricing follows', async () => {
      const coffee = await sellableProduct(app, owner.accessToken, {
        priceAmount: 500,
        quantity: 100,
      })
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'percentage',
        value: 1000,
        appliesTo: 'products',
        productIds: [],
      })

      // Scoped to nothing, the code covers nothing in the basket and is
      // refused outright rather than quietly quoted at zero.
      const empty = await check(await basket(2000), { code: discount.code })
      expect(empty.status).toBe(422)
      expect(empty.body.message).toMatch(/does not apply to anything/)

      const scoped = await patch(discount.id, { productIds: [coffee.id] })
      expect(scoped.status).toBe(200)
      expect(scoped.body.data.productIds).toEqual([coffee.id])

      // And now it is worth a tenth of the basket, because the basket is that
      // product. The edit reached the pricing, not just the record.
      const shopper = guest(app)
      const added = await shopper
        .post('/api/v1/storefront/cart/items')
        .send({ variantId: coffee.variants[0]!.id, quantity: 4 })
      expect(added.status).toBe(201)
      const worth = await check(shopper, { code: discount.code })
      expect(worth.body.data.amount.amount).toBe(200)
    })

    it('narrows an order-wide code to products without touching what it already gave away', async () => {
      const discount = await createDiscount(app, owner.accessToken)

      const res = await patch(discount.id, { appliesTo: 'products', productIds: [] })

      expect(res.status).toBe(200)
      expect(res.body.data.appliesTo).toBe('products')
    })

    it('decides the status on the server, six ways', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString()
      const past = new Date(Date.now() - 86_400_000).toISOString()

      const live = await createDiscount(app, owner.accessToken)
      const scheduled = await createDiscount(app, owner.accessToken, { startsAt: future })
      const off = await createDiscount(app, owner.accessToken)
      await patch(off.id, { isActive: false })
      const finished = await createDiscount(app, owner.accessToken, {
        startsAt: past,
        endsAt: new Date(Date.now() - 3600_000).toISOString(),
      })
      const archived = await createDiscount(app, owner.accessToken)
      await request(app)
        .delete(`/api/v1/admin/discounts/${archived.id}`)
        .set('Authorization', bearer(owner.accessToken))

      const statusOf = async (id: string) =>
        (await adminGet(`/admin/discounts/${id}`)).body.data.status

      expect(await statusOf(live.id)).toBe('active')
      expect(await statusOf(scheduled.id)).toBe('scheduled')
      expect(await statusOf(off.id)).toBe('inactive')
      expect(await statusOf(finished.id)).toBe('expired')
      expect(await statusOf(archived.id)).toBe('archived')
    })

    it('filters by that same status in SQL, so the pager is not lying', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString()
      const live = await createDiscount(app, owner.accessToken)
      const scheduled = await createDiscount(app, owner.accessToken, { startsAt: future })

      const activeOnly = await adminGet('/admin/discounts?status=active')
      const scheduledOnly = await adminGet('/admin/discounts?status=scheduled')

      const codes = (res: { body: { data: { code: string }[] } }) =>
        res.body.data.map((row) => row.code)
      expect(codes(activeOnly)).toContain(live.code)
      expect(codes(activeOnly)).not.toContain(scheduled.code)
      expect(codes(scheduledOnly)).toEqual([scheduled.code])
      // The count is narrowed too, or the pager offers pages that are not there.
      expect(scheduledOnly.body.meta.pagination.total).toBe(1)
    })

    it('finds a code by its code or its title', async () => {
      const summer = await createDiscount(app, owner.accessToken, {
        code: 'SUMMER25',
        title: 'Summer sale',
      })
      await createDiscount(app, owner.accessToken, { code: 'WINTER10', title: 'Winter sale' })

      const byCode = await adminGet('/admin/discounts?q=summer')
      const byTitle = await adminGet('/admin/discounts?q=Summer sale')

      expect(byCode.body.data.map((row: { code: string }) => row.code)).toEqual([summer.code])
      expect(byTitle.body.data).toHaveLength(1)
    })

    it('hides archived codes unless they are asked for', async () => {
      const discount = await createDiscount(app, owner.accessToken)
      await request(app)
        .delete(`/api/v1/admin/discounts/${discount.id}`)
        .set('Authorization', bearer(owner.accessToken))

      const hidden = await adminGet('/admin/discounts')
      const shown = await adminGet('/admin/discounts?includeArchived=true')

      expect(hidden.body.data).toHaveLength(0)
      expect(shown.body.data).toHaveLength(1)
      expect(shown.body.data[0].status).toBe('archived')
    })

    it('says what a code has actually given away, not just how many times', async () => {
      // `usage_count` says 1; the question a manager is really asking is what
      // that cost and on whose order.
      const discount = await createDiscount(app, owner.accessToken, {
        type: 'percentage',
        value: 1000,
      })
      const shopper = await createUserAndLogin(app)
      const cart = await basket(2000, shopper.accessToken)
      const placed = await checkout(cart, {
        shippingMethodId: methodId,
        discountCode: discount.code,
        token: shopper.accessToken,
      })
      expect(placed.status).toBe(201)

      const res = await adminGet(`/admin/discounts/${discount.id}/redemptions`)

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({
        orderNumber: placed.body.data.orderNumber,
        customerEmail: shopper.user.email,
      })
      expect(res.body.data[0].amount.amount).toBe(200)
      // And the campaign's total, so the page is not summing one page of rows.
      expect(res.body.meta.totalAmount.amount).toBe(200)
    })

    it('answers an empty ledger for a code nobody has used', async () => {
      const discount = await createDiscount(app, owner.accessToken)

      const res = await adminGet(`/admin/discounts/${discount.id}/redemptions`)

      expect(res.body.data).toEqual([])
      expect(res.body.meta.totalAmount.amount).toBe(0)
    })

    it('keeps the ledger behind discounts:read', async () => {
      const discount = await createDiscount(app, owner.accessToken)
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const res = await request(app)
        .get(`/api/v1/admin/discounts/${discount.id}/redemptions`)
        .set('Authorization', bearer(staff.accessToken))

      // Staff hold neither discounts permission: money-off is a commercial
      // decision, and so is knowing what it cost.
      expect(res.status).toBe(403)
    })
  })
})
