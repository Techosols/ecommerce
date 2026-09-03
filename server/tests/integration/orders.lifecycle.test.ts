/**
 * The order lifecycle (§5.6, §18).
 *
 * Three orthogonal status machines, each with its own legal moves, plus the two
 * operations that move stock: confirmation takes it off the shelf, cancellation
 * puts it back. The distinction that matters throughout is between stock that
 * is *held* and stock that has *gone* — they come back by different routes and
 * the ledger has to say which happened.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
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

describeIfDatabase('order lifecycle', () => {
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
      .set('Idempotency-Key', `00000000-0000-4000-9000-${String(keyCounter).padStart(12, '0')}`)
      .send(body)
  }
  const patch = (path: string, body: object = {}) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)
  const del = (path: string) =>
    request(app).delete(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))

  async function placeOrder(options: { quantity?: number; priceAmount?: number } = {}) {
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: options.priceAmount ?? 5000,
      quantity: options.quantity ?? 10,
    })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const res = await checkout(shopper, { shippingMethodId: methodId })
    return { orderId: res.body.data.id as string, product, body: res.body.data }
  }

  const levelFor = async (variantId: string) =>
    (await get(`/admin/inventory/variants/${variantId}`)).body.data.levels[0]

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

  // ── Transitions ───────────────────────────────────────────────────────────

  describe('status transitions', () => {
    it('refuses a move that is not legal from the current state', async () => {
      const { orderId } = await placeOrder()
      // pending → completed skips confirmation entirely.
      const res = await post(`/admin/orders/${orderId}/transitions`, {
        field: 'status',
        to: 'completed',
      })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_ORDER_TRANSITION')
    })

    it('refuses to revive a cancelled order', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/cancel`, {})

      const res = await post(`/admin/orders/${orderId}/transitions`, {
        field: 'status',
        to: 'confirmed',
      })
      expect(res.status).toBe(422)
    })

    it('moves the three machines independently', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/confirm`)
      await post(`/admin/orders/${orderId}/transitions`, { field: 'status', to: 'processing' })

      const detail = await get(`/admin/orders/${orderId}`)
      expect(detail.body.data).toMatchObject({
        status: 'processing',
        paymentStatus: 'pending',
        fulfillmentStatus: 'unfulfilled',
      })
    })

    it('records who moved it and why', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/transitions`, {
        field: 'status',
        to: 'cancelled',
        reason: 'Out of stock at the supplier',
      })

      const history = await get(`/admin/orders/${orderId}/history`)
      const cancelled = history.body.data.find(
        (entry: { to: string }) => entry.to === 'cancelled',
      )
      expect(cancelled).toMatchObject({
        field: 'status',
        actorType: 'staff',
        actorUserId: owner.user.id,
        reason: 'Out of stock at the supplier',
      })
    })

    it('keeps the history append-only', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/confirm`)

      // The trigger refuses an UPDATE, so the record of what happened cannot be
      // edited after the fact — it is evidence, not a working note.
      await expect(
        query(`UPDATE order_status_history SET to_value = 'tampered' WHERE order_id = $1`, [
          orderId,
        ]),
      ).rejects.toThrow()
    })

    it('is a no-op when asked to move somewhere it already is', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/confirm`)
      const res = await post(`/admin/orders/${orderId}/transitions`, {
        field: 'status',
        to: 'confirmed',
      })
      expect(res.status).toBe(200)
    })
  })

  // ── Confirmation ──────────────────────────────────────────────────────────

  describe('confirmation', () => {
    it('takes the stock off the shelf', async () => {
      const { orderId, product } = await placeOrder({ quantity: 10 })
      const variantId = product.variants[0]!.id

      expect(await levelFor(variantId)).toMatchObject({ onHand: 10, reserved: 1, available: 9 })
      await post(`/admin/orders/${orderId}/confirm`)
      expect(await levelFor(variantId)).toMatchObject({ onHand: 9, reserved: 0, available: 9 })
    })

    it('records the purchase against the customer', async () => {
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        token: customer.accessToken,
      })

      await post(`/admin/orders/${placed.body.data.id}/confirm`)

      const row = await queryOne<{ orders_count: number; total_spent_cents: string }>(
        `SELECT orders_count, total_spent_cents FROM users WHERE id = $1`,
        [customer.user.id],
      )
      expect(row).toMatchObject({ orders_count: 1 })
      expect(Number(row?.total_spent_cents)).toBe(5499)
    })
  })

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe('cancellation', () => {
    it('releases a hold when the order was never confirmed', async () => {
      const { orderId, product } = await placeOrder({ quantity: 10 })
      const variantId = product.variants[0]!.id

      await post(`/admin/orders/${orderId}/cancel`, { reason: 'Changed their mind' })

      // Released, not returned: nothing ever left, so on_hand is untouched.
      expect(await levelFor(variantId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 })

      const movements = await query<{ reason: string }>(
        `SELECT reason FROM inventory_movements ORDER BY id`,
      )
      expect(movements.map((m) => m.reason)).not.toContain('return')
    })

    it('takes stock back as an explicit return once it has gone', async () => {
      const { orderId, product } = await placeOrder({ quantity: 10 })
      const variantId = product.variants[0]!.id
      await post(`/admin/orders/${orderId}/confirm`)
      expect(await levelFor(variantId)).toMatchObject({ onHand: 9 })

      await post(`/admin/orders/${orderId}/cancel`, { reason: 'Customer refused delivery' })

      expect(await levelFor(variantId)).toMatchObject({ onHand: 10, available: 10 })
      // The ledger says *why* it came back rather than showing an unexplained
      // increase — stock is financial data.
      const movements = await query<{ reason: string }>(
        `SELECT reason FROM inventory_movements ORDER BY id`,
      )
      expect(movements.map((m) => m.reason)).toContain('return')
    })

    it('lets staff keep the goods off the shelf', async () => {
      const { orderId, product } = await placeOrder({ quantity: 10 })
      await post(`/admin/orders/${orderId}/confirm`)

      await post(`/admin/orders/${orderId}/cancel`, { reason: 'Damaged', restock: false })

      // Still gone: a damaged return is not sellable stock.
      expect(await levelFor(product.variants[0]!.id)).toMatchObject({ onHand: 9 })
    })

    it('refuses to cancel an order that has already shipped', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/confirm`)
      const detail = await get(`/admin/orders/${orderId}`)
      await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: detail.body.data.items[0].id, quantity: 1 }],
      })

      const res = await post(`/admin/orders/${orderId}/cancel`, {})
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/refund and return/i)
    })

    it('stamps the cancellation date, as the database insists', async () => {
      // `cancelled_orders_have_a_date` is a CHECK: a cancelled order without a
      // date, or a date without the status, cannot be stored at all.
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/cancel`, {})

      const row = await queryOne<{ cancelled_at: Date | null }>(
        `SELECT cancelled_at FROM orders WHERE id = $1`,
        [orderId],
      )
      expect(row?.cancelled_at).toBeInstanceOf(Date)
    })

    it('lets a customer cancel their own order but not somebody else’s', async () => {
      const mine = await createUserAndLogin(app)
      const theirs = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        token: mine.accessToken,
      })
      const orderId = placed.body.data.id

      const intruder = await request(app)
        .post(`/api/v1/storefront/orders/${orderId}/cancel`)
        .set('Authorization', bearer(theirs.accessToken))
        .send({})
      // 404 rather than 403: the route must not confirm the order exists.
      expect(intruder.status).toBe(404)

      const own = await request(app)
        .post(`/api/v1/storefront/orders/${orderId}/cancel`)
        .set('Authorization', bearer(mine.accessToken))
        .send({ reason: 'No longer needed' })
      expect(own.status).toBe(200)
      expect(own.body.data.status).toBe('cancelled')
    })
  })

  // ── Fulfilment ────────────────────────────────────────────────────────────

  describe('fulfilment', () => {
    it('derives partial fulfilment from what has actually shipped', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 3)
      const placed = await checkout(shopper, { shippingMethodId: methodId })
      const orderId = placed.body.data.id
      await post(`/admin/orders/${orderId}/confirm`)

      const detail = await get(`/admin/orders/${orderId}`)
      const itemId = detail.body.data.items[0].id

      await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: itemId, quantity: 1 }],
      })
      expect((await get(`/admin/orders/${orderId}`)).body.data.fulfillmentStatus).toBe(
        'partially_fulfilled',
      )

      await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: itemId, quantity: 2 }],
      })
      expect((await get(`/admin/orders/${orderId}`)).body.data.fulfillmentStatus).toBe('fulfilled')
    })

    it('refuses to ship more units than were ordered', async () => {
      const { orderId } = await placeOrder()
      await post(`/admin/orders/${orderId}/confirm`)
      const detail = await get(`/admin/orders/${orderId}`)

      const res = await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: detail.body.data.items[0].id, quantity: 99 }],
      })
      expect(res.status).toBe(422)
    })

    it('refuses a line that belongs to a different order', async () => {
      const a = await placeOrder()
      const b = await placeOrder()
      await post(`/admin/orders/${a.orderId}/confirm`)
      const bDetail = await get(`/admin/orders/${b.orderId}`)

      const res = await post(`/admin/orders/${a.orderId}/shipments`, {
        items: [{ orderItemId: bDetail.body.data.items[0].id, quantity: 1 }],
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/does not belong/i)
    })
  })

  // ── Finding an order again ────────────────────────────────────────────────

  describe('guest lookup', () => {
    const lookup = (body: object) =>
      request(app).post('/api/v1/storefront/orders/lookup').send(body)

    async function guestOrder(email = 'guest@example.test') {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const res = await checkout(shopper, { shippingMethodId: methodId, email })
      return { orderNumber: res.body.data.orderNumber as string, id: res.body.data.id as string }
    }

    it('lets a guest find their order with the number and the email', async () => {
      // Without this a guest checkout is a one-way door: the 201 is the only
      // time they ever see the order, and closing the tab loses it.
      const order = await guestOrder()

      const res = await lookup({ orderNumber: order.orderNumber, email: 'guest@example.test' })

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(order.id)
      expect(res.body.data.items).toHaveLength(1)
    })

    it('needs both halves', async () => {
      const order = await guestOrder()

      const wrongEmail = await lookup({
        orderNumber: order.orderNumber,
        email: 'someone.else@example.test',
      })
      const wrongNumber = await lookup({ orderNumber: '#999999', email: 'guest@example.test' })

      // The same answer either way, so this cannot be used to learn which
      // numbers exist or which addresses have shopped here.
      expect(wrongEmail.status).toBe(404)
      expect(wrongNumber.status).toBe(404)
      expect(wrongEmail.body.message).toBe(wrongNumber.body.message)
    })

    it('will not surface an order that belongs to an account', async () => {
      // Order numbers come from a sequence and are guessable, so without this
      // anyone who knew a customer's address could walk the numbers and read
      // their history without a password. A registered customer signs in.
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: customer.user.email,
        token: customer.accessToken,
      })

      const res = await lookup({
        orderNumber: placed.body.data.orderNumber,
        email: customer.user.email,
      })
      expect(res.status).toBe(404)
    })

    it('will not surface a registered account\u2019s order placed as a guest', async () => {
      // The regression this guards: checkout now attaches a customer to every
      // order, so a lookup keyed on "no customer" would have started matching
      // registered people's orders. What keeps them out is that their account
      // has a password \u2014 they have somewhere to sign in.
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      // No token: they checked out without signing in, under their own email.
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: customer.user.email,
      })

      const res = await lookup({
        orderNumber: placed.body.data.orderNumber,
        email: customer.user.email,
      })
      expect(res.status).toBe(404)
    })

    it('shows the customer view, not the operational one', async () => {
      const order = await guestOrder()
      await request(app)
        .put(`/api/v1/admin/orders/${order.id}/note`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ note: 'Ring the supplier' })

      const res = await lookup({ orderNumber: order.orderNumber, email: 'guest@example.test' })

      expect(res.body.data.adminNote).toBeUndefined()
      expect(JSON.stringify(res.body.data)).not.toMatch(/Ring the supplier/)
    })

    it('matches the email case-insensitively', async () => {
      const order = await guestOrder('Mixed.Case@Example.test')
      const res = await lookup({
        orderNumber: order.orderNumber,
        email: 'mixed.case@example.test',
      })
      expect(res.status).toBe(200)
    })
  })

  // ── What a customer may see ───────────────────────────────────────────────

  describe('a guest cancelling their own order', () => {
    const cancelAsGuest = (body: object) =>
      request(app).post('/api/v1/storefront/orders/lookup/cancel').send(body)

    async function guestOrder(email = 'canceller@example.test') {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const res = await checkout(shopper, { shippingMethodId: methodId, email })
      return { orderNumber: res.body.data.orderNumber as string, id: res.body.data.id as string }
    }

    it('cancels an order that has not been packed', async () => {
      // Without this a guest has to email the shop to stop an order nobody has
      // touched yet — a person's afternoon on both sides.
      const order = await guestOrder()

      const res = await cancelAsGuest({
        orderNumber: order.orderNumber,
        email: 'canceller@example.test',
        reason: 'Ordered the wrong size',
      })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('cancelled')
    })

    it('puts the stock back', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 5 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 2)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: 'restock@example.test',
      })

      await cancelAsGuest({
        orderNumber: placed.body.data.orderNumber,
        email: 'restock@example.test',
      })

      const level = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)
      expect(level.body.data.totals.available).toBe(5)
    })

    it('needs both halves of the claim', async () => {
      const order = await guestOrder()

      const wrongEmail = await cancelAsGuest({
        orderNumber: order.orderNumber,
        email: 'someone@else.test',
      })
      expect(wrongEmail.status).toBe(404)

      const wrongNumber = await cancelAsGuest({
        orderNumber: '#999999',
        email: 'canceller@example.test',
      })
      expect(wrongNumber.status).toBe(404)
    })

    it('cannot cancel an order once something has shipped', async () => {
      const order = await guestOrder('shipped@example.test')
      await post(`/admin/orders/${order.id}/confirm`)
      const detail = await get(`/admin/orders/${order.id}`)
      await post(`/admin/orders/${order.id}/shipments`, {
        items: [{ orderItemId: detail.body.data.items[0].id, quantity: 1 }],
      })

      // The route's own guard passes this through — a shipped order is still
      // `confirmed`, because fulfilment is a separate axis — and the service is
      // what refuses it. That is the right place for the decision to live: the
      // storefront cannot be the thing that decides what is too late to stop.
      const res = await cancelAsGuest({
        orderNumber: order.orderNumber,
        email: 'shipped@example.test',
      })
      expect(res.status).toBe(422)

      const after = await get(`/admin/orders/${order.id}`)
      expect(after.body.data.status).not.toBe('cancelled')
    })

    it('cannot cancel a registered customer’s order', async () => {
      // The whole reason this is safe to leave public: the guest claim resolves
      // only orders whose account has no password. Without that, anyone who
      // knew a customer's address could walk the number sequence and cancel
      // their shopping.
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: customer.user.email,
        token: customer.accessToken,
      })

      const res = await cancelAsGuest({
        orderNumber: placed.body.data.orderNumber,
        email: customer.user.email,
      })

      expect(res.status).toBe(404)
    })
  })

  describe('scoping', () => {
    it('hides the internal note from the customer’s own view', async () => {
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        token: customer.accessToken,
      })
      await request(app)
        .put(`/api/v1/admin/orders/${placed.body.data.id}/note`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ note: 'Chase the supplier about this one' })

      const mine = await request(app)
        .get(`/api/v1/storefront/orders/${placed.body.data.id}`)
        .set('Authorization', bearer(customer.accessToken))

      expect(mine.body.data.adminNote).toBeUndefined()
      expect(JSON.stringify(mine.body.data)).not.toMatch(/Chase the supplier/)
    })

    it('does not show one customer another’s order', async () => {
      const mine = await createUserAndLogin(app)
      const theirs = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        token: mine.accessToken,
      })

      const res = await request(app)
        .get(`/api/v1/storefront/orders/${placed.body.data.id}`)
        .set('Authorization', bearer(theirs.accessToken))
      expect(res.status).toBe(404)
    })

    it('requires a session to list orders at all', async () => {
      const res = await request(app).get('/api/v1/storefront/orders')
      expect(res.status).toBe(401)
    })

    it('hides the status history from customers', async () => {
      const customer = await createUserAndLogin(app)
      const { orderId } = await placeOrder()
      const res = await request(app)
        .get(`/api/v1/admin/orders/${orderId}/history`)
        .set('Authorization', bearer(customer.accessToken))
      expect(res.status).toBe(403)
    })
  })

  // ── Notes, tags and the timeline ──────────────────────────────────────────

  describe('staff annotation', () => {
    it('keeps every note, with its author, rather than overwriting one field', async () => {
      const { orderId } = await placeOrder()

      const first = await post(`/admin/orders/${orderId}/notes`, { body: 'Rang about the delay.' })
      expect(first.status).toBe(201)
      await post(`/admin/orders/${orderId}/notes`, { body: 'Second attempt failed.' })

      const res = await get(`/admin/orders/${orderId}/notes`)
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(2)
      // Newest first, and each carries who wrote it.
      expect(res.body.data[0].body).toBe('Second attempt failed.')
      expect(res.body.data[0].authorUserId).toBe(owner.user.id)
      expect(res.body.data[1].body).toBe('Rang about the delay.')

      // The pinned admin note is a different thing and is untouched by notes.
      expect((await get(`/admin/orders/${orderId}`)).body.data.adminNote).toBeNull()
    })

    it('refuses an empty note', async () => {
      const { orderId } = await placeOrder()
      const res = await post(`/admin/orders/${orderId}/notes`, { body: '   ' })
      expect(res.status).toBe(422)
    })

    it('deletes only a note belonging to the named order', async () => {
      const { orderId } = await placeOrder()
      const other = await placeOrder()
      const note = await post(`/admin/orders/${orderId}/notes`, { body: 'Mine.' })
      const noteId = note.body.data.id as string

      // The same id, asked for under the wrong order, is not found rather than
      // silently deleted — an id from one order must not reach another's rows.
      expect((await del(`/admin/orders/${other.orderId}/notes/${noteId}`)).status).toBe(404)
      expect((await get(`/admin/orders/${orderId}/notes`)).body.data).toHaveLength(1)

      expect((await del(`/admin/orders/${orderId}/notes/${noteId}`)).status).toBe(204)
      expect((await get(`/admin/orders/${orderId}/notes`)).body.data).toHaveLength(0)
    })

    it('sets the pinned note and tags in one edit, de-duplicating case-insensitively', async () => {
      const { orderId } = await placeOrder()

      const res = await patch(`/admin/orders/${orderId}/annotations`, {
        note: 'Leave with the neighbour.',
        tags: ['Fragile', 'chase', 'fragile'],
      })

      expect(res.status).toBe(200)
      expect(res.body.data.adminNote).toBe('Leave with the neighbour.')
      // "Fragile" and "fragile" are one tag, and the spelling kept is the one
      // that was typed first.
      expect(res.body.data.tags).toEqual(['Fragile', 'chase'])
    })

    it('refuses a blank tag at the boundary rather than silently dropping it', async () => {
      const { orderId } = await placeOrder()
      const res = await patch(`/admin/orders/${orderId}/annotations`, { tags: ['fragile', '   '] })
      expect(res.status).toBe(422)
    })

    it('refuses an annotation patch that carries neither field', async () => {
      const { orderId } = await placeOrder()
      expect((await patch(`/admin/orders/${orderId}/annotations`, {})).status).toBe(422)
    })

    it('filters the order list to orders carrying every named tag', async () => {
      const both = await placeOrder()
      const one = await placeOrder()
      await placeOrder()

      await patch(`/admin/orders/${both.orderId}/annotations`, { tags: ['fragile', 'chase'] })
      await patch(`/admin/orders/${one.orderId}/annotations`, { tags: ['fragile'] })

      const fragile = await get('/admin/orders?tags=fragile')
      expect(fragile.body.data).toHaveLength(2)

      // Two tags narrows rather than widens: only the order carrying both.
      const chased = await get('/admin/orders?tags=fragile&tags=chase')
      expect(chased.body.data).toHaveLength(1)
      expect(chased.body.data[0].id).toBe(both.orderId)
    })

    it('assembles the timeline from every kind of thing that happened', async () => {
      const { orderId } = await placeOrder()

      await post(`/admin/orders/${orderId}/confirm`)
      await post(`/admin/orders/${orderId}/payments`, {})
      await post(`/admin/orders/${orderId}/notes`, { body: 'Packed.' })

      const res = await get(`/admin/orders/${orderId}/timeline`)
      expect(res.status).toBe(200)

      const kinds = (res.body.data as Array<{ kind: string }>).map((entry) => entry.kind)
      expect(kinds).toContain('status')
      expect(kinds).toContain('payment')
      expect(kinds).toContain('note')

      // Newest first, so the most recent thing is what an operator reads first.
      const times = (res.body.data as Array<{ at: string }>).map((entry) => Date.parse(entry.at))
      expect([...times].sort((a, b) => b - a)).toEqual(times)

      const note = (res.body.data as Array<{ kind: string; body?: string; actorName?: string }>).find(
        (entry) => entry.kind === 'note',
      )
      expect(note?.body).toBe('Packed.')
      // The live account supplies the name; the snapshot is only the fallback.
      expect(note?.actorName).toBeTruthy()

      const payment = (res.body.data as Array<{ kind: string; amount?: { amount: number } }>).find(
        (entry) => entry.kind === 'payment',
      )
      expect(payment?.amount?.amount).toBeGreaterThan(0)
    })

    it('keeps notes and the timeline behind the orders permissions', async () => {
      const { orderId } = await placeOrder()
      const customer = await createUserAndLogin(app)

      for (const path of [`/orders/${orderId}/notes`, `/orders/${orderId}/timeline`]) {
        const res = await request(app)
          .get(`/api/v1/admin${path}`)
          .set('Authorization', bearer(customer.accessToken))
        expect(res.status).toBe(403)
      }
    })
  })

})
