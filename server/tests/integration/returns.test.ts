/**
 * Returns — goods coming back (§5.6).
 *
 * The two things worth proving over and over: the lifecycle refuses moves that
 * are not legal, and receiving puts back **only** what can be sold again. A
 * return that silently restocked damaged goods is the one failure here that
 * reaches a second customer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
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

describeIfDatabase('returns', () => {
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

  /** An order that has been confirmed and paid — the state a return starts from. */
  async function paidOrder(quantity = 3) {
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: 1000,
      quantity: 50,
    })
    const shopper = guest(app)
    const variantId = product.variants[0]!.id
    await addToCart(shopper, variantId, quantity)
    const placed = await checkout(shopper, { shippingMethodId: methodId })
    const orderId = placed.body.data.id as string

    await post(`/admin/orders/${orderId}/confirm`)
    await post(`/admin/orders/${orderId}/payments`, {})

    const detail = await get(`/admin/orders/${orderId}`)
    const payments = await get(`/admin/orders/${orderId}/payments`)

    return {
      orderId,
      variantId,
      lineId: detail.body.data.items[0].id as string,
      paymentId: payments.body.data.payments[0].id as string,
      totalCents: detail.body.data.totals.total.amount as number,
    }
  }

  const available = async (variantId: string) =>
    (await get(`/admin/inventory/variants/${variantId}`)).body.data.totals.available as number

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

  // ── What can come back ────────────────────────────────────────────────────

  describe('returnable', () => {
    it('offers the whole line before anything is returned', async () => {
      const { orderId, lineId } = await paidOrder(3)

      const res = await get(`/admin/orders/${orderId}/returnable`)
      expect(res.status).toBe(200)
      expect(res.body.data.eligible).toBe(true)

      const line = res.body.data.lines.find((l: { orderItemId: string }) => l.orderItemId === lineId)
      expect(line.returnableQuantity).toBe(3)
      expect(line.returnedQuantity).toBe(0)
    })

    it('offers nothing on an order that was never confirmed', async () => {
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, { shippingMethodId: methodId })

      const res = await get(`/admin/orders/${placed.body.data.id}/returnable`)
      expect(res.body.data.eligible).toBe(false)
      // Nothing has gone out, so nothing can come back — and it says so.
      expect(res.body.data.reason).toMatch(/gone out/)
      expect(res.body.data.lines[0].returnableQuantity).toBe(0)
    })

    it('shrinks as units are committed to a return', async () => {
      const { orderId, lineId } = await paidOrder(3)
      await post(`/admin/orders/${orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: lineId, quantity: 2 }],
      })

      const res = await get(`/admin/orders/${orderId}/returnable`)
      expect(res.body.data.lines[0].returnableQuantity).toBe(1)
      expect(res.body.data.lines[0].returnedQuantity).toBe(2)
    })
  })

  // ── A guest, with no account ──────────────────────────────────────────────

  describe('a guest with only their order number', () => {
    /** The pair a guest checkout leaves them holding. */
    async function guestPaidOrder(quantity = 2) {
      const product = await sellableProduct(app, owner.accessToken, {
        priceAmount: 1000,
        quantity: 50,
      })
      const shopper = guest(app)
      const email = `walkin-${Date.now()}@example.test`
      await addToCart(shopper, product.variants[0]!.id, quantity)
      const placed = await checkout(shopper, { shippingMethodId: methodId, email })
      const orderId = placed.body.data.id as string

      await post(`/admin/orders/${orderId}/confirm`)
      await post(`/admin/orders/${orderId}/payments`, {})

      const detail = await get(`/admin/orders/${orderId}`)
      return {
        orderId,
        orderNumber: placed.body.data.orderNumber as string,
        email,
        lineId: detail.body.data.items[0].id as string,
      }
    }

    it('can see what is still returnable', async () => {
      const order = await guestPaidOrder(2)

      const res = await request(app)
        .post('/api/v1/storefront/orders/lookup/returnable')
        .send({ orderNumber: order.orderNumber, email: order.email })

      expect(res.status).toBe(200)
      expect(res.body.data.eligible).toBe(true)
      expect(res.body.data.lines[0].returnableQuantity).toBe(2)
    })

    it('can open a return', async () => {
      const order = await guestPaidOrder(2)

      const res = await request(app)
        .post('/api/v1/storefront/orders/lookup/returns')
        .send({
          orderNumber: order.orderNumber,
          email: order.email,
          reason: 'damaged',
          lines: [{ orderItemId: order.lineId, quantity: 1 }],
        })

      expect(res.status).toBe(201)
      expect(res.body.data.lines[0].quantity).toBe(1)
    })

    it('needs both halves of the claim', async () => {
      // The same indistinguishable 404 as the order lookup, so neither half can
      // be discovered by trying the other.
      const order = await guestPaidOrder(2)

      const wrongEmail = await request(app)
        .post('/api/v1/storefront/orders/lookup/returnable')
        .send({ orderNumber: order.orderNumber, email: 'someone@else.test' })
      expect(wrongEmail.status).toBe(404)

      const wrongNumber = await request(app)
        .post('/api/v1/storefront/orders/lookup/returnable')
        .send({ orderNumber: '#000000', email: order.email })
      expect(wrongNumber.status).toBe(404)
    })

    it('cannot reach an order that belongs to a registered account', async () => {
      // The guest claim resolves only orders with no password on the account.
      // Without that, anyone knowing a customer's address could walk the number
      // sequence and open returns against their history.
      const customer = await createUserAndLogin(app, { roles: ['customer'] })
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, {
        shippingMethodId: methodId,
        email: customer.user.email,
        token: customer.accessToken,
      })

      const res = await request(app)
        .post('/api/v1/storefront/orders/lookup/returnable')
        .send({ orderNumber: placed.body.data.orderNumber, email: customer.user.email })

      expect(res.status).toBe(404)
    })
  })

  // ── Opening ───────────────────────────────────────────────────────────────

  describe('opening a return', () => {
    it('opens one, numbered and requested', async () => {
      const { orderId, lineId } = await paidOrder(2)

      const res = await post(`/admin/orders/${orderId}/returns`, {
        reason: 'wrong_item',
        customerNote: 'Sent the blue one.',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      })

      expect(res.status).toBe(201)
      expect(res.body.data.status).toBe('requested')
      expect(res.body.data.returnNumber).toMatch(/^R\d+$/)
      expect(res.body.data.lines).toHaveLength(1)
      expect(res.body.data.lines[0].quantity).toBe(1)
      // Nothing has arrived, so nothing is received and nothing is restocked.
      expect(res.body.data.lines[0].receivedQuantity).toBe(0)
      expect(res.body.data.lines[0].condition).toBeNull()
    })

    it('refuses more units than were bought, even across two returns', async () => {
      const { orderId, lineId } = await paidOrder(2)
      await post(`/admin/orders/${orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: lineId, quantity: 2 }],
      })

      const second = await post(`/admin/orders/${orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      })
      expect(second.status).toBe(409)
    })

    it('refuses a line from a different order', async () => {
      const mine = await paidOrder(1)
      const theirs = await paidOrder(1)

      const res = await post(`/admin/orders/${mine.orderId}/returns`, {
        reason: 'other',
        lines: [{ orderItemId: theirs.lineId, quantity: 1 }],
      })
      expect(res.status).toBe(422)
    })

    it('gives the units back when the return is declined', async () => {
      const { orderId, lineId } = await paidOrder(2)
      const opened = await post(`/admin/orders/${orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: lineId, quantity: 2 }],
      })

      await post(`/admin/returns/${opened.body.data.id}/decline`, { staffNote: 'Outside the window.' })

      // Declining is not a refusal to record it — it is a refusal to take the
      // goods, so the units go back to being returnable.
      const res = await get(`/admin/orders/${orderId}/returnable`)
      expect(res.body.data.lines[0].returnableQuantity).toBe(2)
    })
  })

  // ── The lifecycle ─────────────────────────────────────────────────────────

  describe('the lifecycle', () => {
    async function openReturn(quantity = 2) {
      const order = await paidOrder(quantity)
      const opened = await post(`/admin/orders/${order.orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: order.lineId, quantity }],
      })
      return { ...order, returnId: opened.body.data.id as string }
    }

    it('walks requested → approved → in transit → received', async () => {
      const { returnId, lineId } = await openReturn(2)

      expect((await post(`/admin/returns/${returnId}/approve`)).body.data.status).toBe('approved')
      expect((await post(`/admin/returns/${returnId}/in-transit`)).body.data.status).toBe('in_transit')

      const received = await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 2, condition: 'resellable' }],
      })
      expect(received.status).toBe(200)
      expect(received.body.data.status).toBe('received')
      expect(received.body.data.receivedAt).not.toBeNull()
    })

    it('refuses a move that is not legal from the current state', async () => {
      const { returnId } = await openReturn()

      // requested → received skips the whole approval.
      const res = await post(`/admin/returns/${returnId}/close`)
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/cannot become closed/)
    })

    it('refuses to reopen a closed return', async () => {
      const { returnId, lineId } = await openReturn(1)
      await post(`/admin/returns/${returnId}/approve`)
      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 1, condition: 'damaged' }],
      })
      await post(`/admin/returns/${returnId}/close`)

      expect((await post(`/admin/returns/${returnId}/approve`)).status).toBe(422)
      expect((await post(`/admin/returns/${returnId}/cancel`)).status).toBe(422)
    })
  })

  // ── Receiving, which is where the stock moves ─────────────────────────────

  describe('receiving', () => {
    async function approved(quantity = 3) {
      const order = await paidOrder(quantity)
      const opened = await post(`/admin/orders/${order.orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: order.lineId, quantity }],
      })
      const returnId = opened.body.data.id as string
      await post(`/admin/returns/${returnId}/approve`)
      return { ...order, returnId }
    }

    it('puts resellable units back on the shelf', async () => {
      const { returnId, lineId, variantId } = await approved(3)
      const before = await available(variantId)

      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 3, condition: 'resellable' }],
      })

      expect(await available(variantId)).toBe(before + 3)
    })

    it('does not restock damaged goods', async () => {
      const { returnId, lineId, variantId } = await approved(3)
      const before = await available(variantId)

      const res = await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 3, condition: 'damaged' }],
      })

      // Received, recorded, and written off. Putting these back is the one
      // failure here that reaches a second customer.
      expect(res.body.data.lines[0].receivedQuantity).toBe(3)
      expect(res.body.data.lines[0].restockedQuantity).toBe(0)
      expect(await available(variantId)).toBe(before)
    })

    it('restocks only what arrived, not what was expected', async () => {
      const { returnId, lineId, variantId } = await approved(3)
      const before = await available(variantId)

      const res = await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 1, condition: 'resellable' }],
      })

      expect(res.body.data.lines[0].receivedQuantity).toBe(1)
      expect(await available(variantId)).toBe(before + 1)
    })

    it('refuses to receive more than was requested', async () => {
      const { returnId, lineId } = await approved(2)
      const res = await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 5, condition: 'resellable' }],
      })
      expect(res.status).toBe(422)
    })

    it('records a movement with a reason, not a silent bump', async () => {
      const { returnId, lineId, variantId } = await approved(2)
      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 2, condition: 'resellable' }],
      })

      const item = await get(`/admin/inventory/variants/${variantId}`)
      const history = await get(`/admin/inventory/items/${item.body.data.id}/history`)
      const entry = (
        history.body.data as Array<{ reason: string; delta: { onHand: number } }>
      ).find((row) => row.reason === 'return')
      expect(entry?.delta.onHand).toBe(2)
    })
  })

  // ── Money ─────────────────────────────────────────────────────────────────

  describe('refunding a return', () => {
    async function received(quantity = 2, condition = 'resellable') {
      const order = await paidOrder(quantity)
      const opened = await post(`/admin/orders/${order.orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: order.lineId, quantity }],
      })
      const returnId = opened.body.data.id as string
      await post(`/admin/returns/${returnId}/approve`)
      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: order.lineId, receivedQuantity: quantity, condition }],
      })
      return { ...order, returnId }
    }

    it('refunds what arrived and closes the return', async () => {
      const { returnId, orderId, paymentId } = await received(2)

      const res = await post(`/admin/returns/${returnId}/refund`, {
        paymentId,
        amountCents: 2000,
      })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('closed')
      expect(res.body.data.refundId).not.toBeNull()

      const order = await get(`/admin/orders/${orderId}`)
      expect(order.body.data.totals.refundedTotal.amount).toBe(2000)
      expect(order.body.data.paymentStatus).toBe('partially_refunded')
    })

    it('does not restock a second time when the refund is issued', async () => {
      const { returnId, paymentId, variantId } = await received(2, 'resellable')
      const afterReceipt = await available(variantId)

      await post(`/admin/returns/${returnId}/refund`, { paymentId, amountCents: 2000 })

      // The goods came back at receipt. Restocking again on the refund would
      // double them, and the shop would then sell stock it does not have.
      expect(await available(variantId)).toBe(afterReceipt)
    })

    it('records the refunded units, so the order cannot refund them twice', async () => {
      const { returnId, orderId, paymentId } = await received(2)
      await post(`/admin/returns/${returnId}/refund`, { paymentId, amountCents: 2000 })

      const refundable = await get(`/admin/orders/${orderId}/refundable`)
      expect(refundable.body.data.lines[0].refundedQuantity).toBe(2)
      expect(refundable.body.data.lines[0].refundableQuantity).toBe(0)
    })

    it('refuses to refund a return nothing arrived for', async () => {
      const order = await paidOrder(1)
      const opened = await post(`/admin/orders/${order.orderId}/returns`, {
        reason: 'other',
        lines: [{ orderItemId: order.lineId, quantity: 1 }],
      })
      const returnId = opened.body.data.id as string
      await post(`/admin/returns/${returnId}/approve`)
      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: order.lineId, receivedQuantity: 0, condition: 'missing_parts' }],
      })

      const res = await post(`/admin/returns/${returnId}/refund`, {
        paymentId: order.paymentId,
        amountCents: 1000,
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/nothing to refund/)
    })

    it('does not re-open a balance the customer does not owe', async () => {
      const { returnId, orderId, paymentId } = await received(2)
      await post(`/admin/returns/${returnId}/refund`, { paymentId, amountCents: 2000 })

      // The payment sum is already net of refunds, so measuring it against the
      // gross total would count the refund twice and tell staff to chase a
      // customer who owes nothing.
      const payments = await get(`/admin/orders/${orderId}/payments`)
      expect(payments.body.data.outstanding.amount).toBe(0)

      // And a second payment cannot be recorded against a settled order.
      const again = await post(`/admin/orders/${orderId}/payments`, {})
      expect(again.status).toBe(422)
      expect(again.body.code).toBe('PAYMENT_ALREADY_SETTLED')
    })

    it('refuses to refund the same return twice', async () => {
      const { returnId, paymentId } = await received(2)
      await post(`/admin/returns/${returnId}/refund`, { paymentId, amountCents: 1000 })

      const second = await post(`/admin/returns/${returnId}/refund`, {
        paymentId,
        amountCents: 1000,
      })
      // Closed already, so the lifecycle refuses it before the money does.
      expect(second.status).toBe(422)
    })

    it('refuses to refund a return that has not been received', async () => {
      const order = await paidOrder(1)
      const opened = await post(`/admin/orders/${order.orderId}/returns`, {
        reason: 'other',
        lines: [{ orderItemId: order.lineId, quantity: 1 }],
      })
      await post(`/admin/returns/${opened.body.data.id}/approve`)

      const res = await post(`/admin/returns/${opened.body.data.id}/refund`, {
        paymentId: order.paymentId,
        amountCents: 1000,
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/record what arrived first/)
    })
  })

  // ── Refundable ────────────────────────────────────────────────────────────

  describe('refundable', () => {
    it('reports the per-line and order-level maxima together', async () => {
      const { orderId, totalCents } = await paidOrder(2)

      const res = await get(`/admin/orders/${orderId}/refundable`)
      expect(res.status).toBe(200)
      // Both limits are real; the smaller one binds.
      expect(res.body.data.maxRefundable.amount).toBe(totalCents)
      expect(res.body.data.lines[0].refundableQuantity).toBe(2)
      expect(res.body.data.payments).toHaveLength(1)
    })

    it('prices a unit at what was paid for it, not at the list price', async () => {
      const { orderId } = await paidOrder(2)
      const res = await get(`/admin/orders/${orderId}/refundable`)

      const line = res.body.data.lines[0]
      // The line's own total divided by its quantity — after its share of any
      // discount and its tax.
      expect(line.perUnit.amount * line.quantity).toBeLessThanOrEqual(
        res.body.data.maxRefundable.amount,
      )
    })

    it('falls to zero once everything has been refunded', async () => {
      const { orderId, lineId, paymentId, totalCents } = await paidOrder(1)
      await post(`/admin/orders/${orderId}/refunds`, {
        paymentId,
        amountCents: totalCents,
        items: [{ orderItemId: lineId, quantity: 1 }],
      })

      const res = await get(`/admin/orders/${orderId}/refundable`)
      expect(res.body.data.maxRefundable.amount).toBe(0)
      expect(res.body.data.lines[0].refundableQuantity).toBe(0)
    })
  })

  // ── Permissions ───────────────────────────────────────────────────────────

  describe('permissions', () => {
    it('lets staff run the returns desk but not pay for it', async () => {
      const { orderId, lineId, paymentId } = await paidOrder(1)
      const opened = await post(`/admin/orders/${orderId}/returns`, {
        reason: 'damaged',
        lines: [{ orderItemId: lineId, quantity: 1 }],
      })
      const returnId = opened.body.data.id as string
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const approve = await request(app)
        .post(`/api/v1/admin/returns/${returnId}/approve`)
        .set('Authorization', bearer(staff.accessToken))
        .send({})
      expect(approve.status).toBe(200)

      await post(`/admin/returns/${returnId}/receive`, {
        lines: [{ orderItemId: lineId, receivedQuantity: 1, condition: 'resellable' }],
      })

      // Deciding goods may come back and deciding to send money are two
      // approvals. Staff hold the first and not the second.
      const refund = await request(app)
        .post(`/api/v1/admin/returns/${returnId}/refund`)
        .set('Authorization', bearer(staff.accessToken))
        .send({ paymentId, amountCents: 100 })
      expect(refund.status).toBe(403)
    })

    it('refuses a customer the returns queue entirely', async () => {
      const customer = await createUserAndLogin(app)
      const res = await request(app)
        .get('/api/v1/admin/returns')
        .set('Authorization', bearer(customer.accessToken))
      expect(res.status).toBe(403)
    })
  })

  // ── The customer's own view ───────────────────────────────────────────────

  describe('the customer', () => {
    it('opens a return on their own order and sees it back', async () => {
      const customer = await createUserAndLogin(app)
      const product = await sellableProduct(app, owner.accessToken, { quantity: 10 })

      const placed = await request(app)
        .post('/api/v1/storefront/cart/items')
        .set('Authorization', bearer(customer.accessToken))
        .send({ variantId: product.variants[0]!.id, quantity: 1 })
      expect(placed.status).toBeLessThan(300)

      const order = await request(app)
        .post('/api/v1/storefront/checkout')
        .set('Authorization', bearer(customer.accessToken))
        .set('Idempotency-Key', '00000000-0000-4000-9000-0000000000f1')
        .send({
          email: customer.user.email,
          paymentMethod: 'cod',
          shippingMethodId: methodId,
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Buyer',
            line1: '1 High Street',
            city: 'Leeds',
            postalCode: 'LS1 1AA',
            countryCode: 'GB',
          },
        })
      const orderId = order.body.data.id as string
      await post(`/admin/orders/${orderId}/confirm`)

      const returnable = await request(app)
        .get(`/api/v1/storefront/orders/${orderId}/returnable`)
        .set('Authorization', bearer(customer.accessToken))
      expect(returnable.status).toBe(200)

      const opened = await request(app)
        .post(`/api/v1/storefront/orders/${orderId}/returns`)
        .set('Authorization', bearer(customer.accessToken))
        .send({
          reason: 'no_longer_wanted',
          lines: [{ orderItemId: returnable.body.data.lines[0].orderItemId, quantity: 1 }],
        })
      expect(opened.status).toBe(201)
      // No staff note, no refund id: the operational half stays inside.
      expect(opened.body.data.staffNote).toBeUndefined()
      expect(opened.body.data.refundId).toBeUndefined()

      const mine = await request(app)
        .get('/api/v1/storefront/returns')
        .set('Authorization', bearer(customer.accessToken))
      expect(mine.body.data).toHaveLength(1)
    })

    it('cannot open a return on somebody else’s order', async () => {
      const { orderId, lineId } = await paidOrder(1)
      const stranger = await createUserAndLogin(app)

      const res = await request(app)
        .post(`/api/v1/storefront/orders/${orderId}/returns`)
        .set('Authorization', bearer(stranger.accessToken))
        .send({ reason: 'other', lines: [{ orderItemId: lineId, quantity: 1 }] })
      // 404, not 403: "that exists but is not yours" is itself a fact about
      // somebody else's shopping.
      expect(res.status).toBe(404)
    })
  })
})
