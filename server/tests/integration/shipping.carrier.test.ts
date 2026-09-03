/**
 * The courier seam, end to end (§7.1).
 *
 * Four capabilities were asked for, and each one has a failure mode that is
 * more interesting than its happy path, because a courier is somebody else's
 * server:
 *
 *   rates       the courier is slow or down, and the shop still sells
 *   booking     the courier refuses, and no half-made shipment is left behind
 *   tracking    the same scan arrives twice, and nothing happens twice
 *   remittance  the statement disagrees with the order, and nobody banks it
 *
 * So the suite spends most of its length on those, and on the one property the
 * whole design rests on: with no courier connected, the shop behaves exactly as
 * it did before couriers were pluggable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { setCarrier } from '../../src/infrastructure/carriers/index.js'
import { applyTracking } from '../../src/jobs/shipping/pollTracking.job.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createShippingMethod,
  guest,
  sellableProduct,
} from '../factories/commerce.js'
import { FakeCarrierProvider, signFakeWebhook } from '../fakes/carrier.js'
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

describeIfDatabase('carrier integration', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let zoneId: string
  let carrier: FakeCarrierProvider

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const post = (path: string, body: object = {}) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', crypto.randomUUID())
      .send(body)

  /** A confirmed COD order with one unit, ready to ship. */
  async function codOrder(priceAmount = 5000) {
    const product = await sellableProduct(app, owner.accessToken, { priceAmount, quantity: 10 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const placed = await checkout(shopper, { paymentMethod: 'cod', shippingMethodId: methodId })
    const orderId = placed.body.data.id as string
    await post(`/admin/orders/${orderId}/confirm`)
    const detail = await get(`/admin/orders/${orderId}`)
    return {
      orderId,
      itemId: detail.body.data.items[0].id as string,
      totalCents: detail.body.data.totals.total.amount as number,
      currency: detail.body.data.totals.total.currency as string,
    }
  }

  async function ship(orderId: string, itemId: string) {
    const res = await post(`/admin/orders/${orderId}/shipments`, {
      items: [{ orderItemId: itemId, quantity: 1 }],
    })
    if (res.status !== 201) throw new Error(`ship failed: ${JSON.stringify(res.body)}`)
    return res.body.data as { id: string; trackingNumber: string | null }
  }

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId, zoneId } = await createShippingMethod(app, owner.accessToken, {
      priceCents: 499,
    }))
    carrier = new FakeCarrierProvider()
    setCarrier(carrier)
  })
  afterEach(async () => {
    setCarrier(undefined)
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── The default: no courier ───────────────────────────────────────────────

  describe('with no courier connected', () => {
    beforeEach(() => setCarrier(undefined))

    it('reports every capability as unavailable', async () => {
      const res = await get('/admin/shipping/carrier')
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        provider: 'manual',
        quotes: false,
        booking: false,
        tracking: false,
        remittance: false,
        canImportRemittances: false,
      })
    })

    it('still ships a parcel, with whatever the operator typed', async () => {
      const { orderId, itemId } = await codOrder()
      const res = await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: itemId, quantity: 1 }],
        carrier: 'Local courier',
        trackingNumber: 'HAND-WRITTEN-1',
      })

      expect(res.status).toBe(201)
      expect(res.body.data.trackingNumber).toBe('HAND-WRITTEN-1')
      // No provider recorded, so the tracking sweep will never ask about it.
      const row = await queryOne<{ carrier_provider: string | null }>(
        `SELECT carrier_provider FROM shipments WHERE id = $1`,
        [res.body.data.id],
      )
      expect(row?.carrier_provider).toBeNull()
    })

    it('refuses to import a statement it cannot read', async () => {
      const res = await post('/admin/shipping/cod/remittances', {
        filename: 'statement.csv',
        content: Buffer.from('anything').toString('base64'),
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/cannot produce/i)
    })
  })

  // ── Live rates ────────────────────────────────────────────────────────────

  describe('live rates at checkout', () => {
    const rates = (countryCode = 'GB') =>
      request(app).get(
        `/api/v1/storefront/shipping/rates?countryCode=${countryCode}&subtotalCents=5000&weightGrams=500`,
      )

    const quote = (amountCents: number) => ({
      serviceCode: 'OVERNIGHT',
      serviceName: 'Overnight',
      amountCents,
      currency: 'USD',
      estimatedDaysMin: 1,
      estimatedDaysMax: 1,
    })

    it('takes the courier’s price when it undercuts the shop’s', async () => {
      setCarrier(new FakeCarrierProvider({ quotes: [quote(299)] }))

      const res = await rates()
      expect(res.status).toBe(200)
      expect(res.body.data[0].price.amount).toBe(299)
      // Still the shop's method: its id is what checkout sends back.
      expect(res.body.data[0].id).toBe(methodId)
    })

    it('keeps the shop’s price when the courier wants more', async () => {
      setCarrier(new FakeCarrierProvider({ quotes: [quote(1500)] }))

      const res = await rates()
      expect(res.body.data[0].price.amount).toBe(499)
    })

    it('sells at the shop’s rate when the courier is too slow to answer', async () => {
      // Comfortably past the 2.5s quoting timeout: a shopper staring at a
      // spinner is a shopper leaving, and the sale must not depend on
      // somebody else's server.
      setCarrier(new FakeCarrierProvider({ quotes: [quote(1)], delayMs: 3_000 }))

      const started = Date.now()
      const res = await rates()

      expect(res.status).toBe(200)
      expect(res.body.data[0].price.amount).toBe(499)
      expect(Date.now() - started).toBeLessThan(3_000)
    })

    it('sells at the shop’s rate when the courier refuses outright', async () => {
      setCarrier(new FakeCarrierProvider({ failNext: new Set(['quote']) }))

      const res = await rates()
      expect(res.status).toBe(200)
      expect(res.body.data[0].price.amount).toBe(499)
    })

    it('leaves free delivery free, whatever the courier charges', async () => {
      // In the same zone: a second zone naming GB would be refused, and rightly
      // so — a shopper there would otherwise be quoted two rate cards at once.
      const free = await post('/admin/shipping/methods', {
        zoneId,
        name: 'Free delivery',
        rateType: 'flat',
        priceCents: 0,
      })
      setCarrier(new FakeCarrierProvider({ quotes: [quote(299)] }))

      const res = await rates()
      const freeRate = res.body.data.find(
        (rate: { id: string }) => rate.id === free.body.data.id,
      )
      expect(freeRate.price.amount).toBe(0)
    })
  })

  // ── Booking ───────────────────────────────────────────────────────────────

  describe('booking', () => {
    it('books the consignment and keeps the courier’s tracking number', async () => {
      const { orderId, itemId } = await codOrder()
      const shipment = await ship(orderId, itemId)

      expect(shipment.trackingNumber).toBe('FAKE000001')
      const row = await queryOne<{
        carrier_provider: string
        carrier_consignment_id: string
        tracking_url: string
      }>(
        `SELECT carrier_provider, carrier_consignment_id, tracking_url
           FROM shipments WHERE id = $1`,
        [shipment.id],
      )
      expect(row).toMatchObject({
        carrier_provider: 'fake',
        carrier_consignment_id: 'CN-FAKE000001',
        tracking_url: 'https://fake.example/track/FAKE000001',
      })
    })

    it('tells the courier to collect the money on an unpaid COD order', async () => {
      const { orderId, itemId, totalCents } = await codOrder()
      await ship(orderId, itemId)

      expect(carrier.booked[0]!.codAmountCents).toBe(totalCents)
    })

    it('does not ask the courier for cash on an order already paid', async () => {
      const { orderId, itemId } = await codOrder()
      await post(`/admin/orders/${orderId}/payments`, { method: 'cod' })
      await ship(orderId, itemId)

      expect(carrier.booked[0]!.codAmountCents).toBe(0)
    })

    it('leaves nothing behind when the courier refuses', async () => {
      const { orderId, itemId } = await codOrder()
      carrier = new FakeCarrierProvider({ failNext: new Set(['book']) })
      setCarrier(carrier)

      const res = await post(`/admin/orders/${orderId}/shipments`, {
        items: [{ orderItemId: itemId, quantity: 1 }],
      })

      // The operator is told, rather than handed a shipment the courier has
      // never heard of.
      expect(res.status).toBeGreaterThanOrEqual(400)
      const rows = await query(`SELECT id FROM shipments WHERE order_id = $1`, [orderId])
      expect(rows).toHaveLength(0)
      // And the line is still unshipped, so it can be tried again.
      const detail = await get(`/admin/orders/${orderId}`)
      expect(detail.body.data.fulfillmentStatus).toBe('unfulfilled')
    })
  })

  // ── Tracking ──────────────────────────────────────────────────────────────

  describe('tracking', () => {
    const scan = (status: string, at: string, description = status) => ({
      status,
      description,
      at,
      raw: `RAW_${status.toUpperCase()}`,
    })

    it('records scans and moves the shipment on', async () => {
      const { orderId, itemId } = await codOrder()
      const shipment = await ship(orderId, itemId)

      const body = {
        trackingNumber: 'FAKE000001',
        events: [
          scan('in_transit', '2026-08-01T09:00:00.000Z', 'Departed origin hub'),
          scan('delivered', '2026-08-02T14:30:00.000Z', 'Delivered to recipient'),
        ],
      }
      const { raw, signature } = signFakeWebhook(body)

      const res = await request(app)
        .post('/api/v1/webhooks/carriers/fake')
        .set('Content-Type', 'application/json')
        .set('x-fake-signature', signature)
        .send(raw)

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ received: true, applied: true })

      const events = await get(`/admin/shipping/shipments/${shipment.id}/tracking`)
      expect(events.body.data).toHaveLength(2)
      // Newest first, and the courier's own code kept beside our word for it.
      expect(events.body.data[0]).toMatchObject({
        status: 'delivered',
        rawStatus: 'RAW_DELIVERED',
        provider: 'fake',
      })

      const row = await queryOne<{ status: string }>(
        `SELECT status FROM shipments WHERE id = $1`,
        [shipment.id],
      )
      expect(row?.status).toBe('delivered')
    })

    it('does nothing the second time the same scan arrives', async () => {
      const { orderId, itemId } = await codOrder()
      const shipment = await ship(orderId, itemId)

      const body = {
        trackingNumber: 'FAKE000001',
        events: [scan('delivered', '2026-08-02T14:30:00.000Z', 'Delivered to recipient')],
      }
      const { raw, signature } = signFakeWebhook(body)
      const send = () =>
        request(app)
          .post('/api/v1/webhooks/carriers/fake')
          .set('Content-Type', 'application/json')
          .set('x-fake-signature', signature)
          .send(raw)

      await send()
      const second = await send()

      // 200 — a courier that gets anything else redelivers for ever — but
      // nothing was applied.
      expect(second.status).toBe(200)
      expect(second.body.data.applied).toBe(false)

      const events = await get(`/admin/shipping/shipments/${shipment.id}/tracking`)
      expect(events.body.data).toHaveLength(1)
    })

    it('follows a parcel backwards when a delivery fails after being out', async () => {
      const { orderId, itemId } = await codOrder()
      const shipment = await ship(orderId, itemId)

      // Deliberately out of order in the payload: the courier's clock decides,
      // not the array.
      await applyTracking(shipment.id, 'fake', [
        {
          status: 'failed',
          description: 'Recipient not available',
          location: null,
          occurredAt: new Date('2026-08-02T16:00:00.000Z'),
          rawStatus: 'RAW_FAILED',
        },
        {
          status: 'in_transit',
          description: 'Out for delivery',
          location: null,
          occurredAt: new Date('2026-08-02T08:00:00.000Z'),
          rawStatus: 'RAW_OFD',
        },
      ])

      const row = await queryOne<{ status: string }>(
        `SELECT status FROM shipments WHERE id = $1`,
        [shipment.id],
      )
      expect(row?.status).toBe('failed')
    })

    it('refuses a callback with a bad signature', async () => {
      const body = { trackingNumber: 'FAKE000001', events: [scan('delivered', '2026-08-02T14:30:00.000Z')] }
      const { raw } = signFakeWebhook(body)

      const res = await request(app)
        .post('/api/v1/webhooks/carriers/fake')
        .set('Content-Type', 'application/json')
        .set('x-fake-signature', 'f'.repeat(64))
        .send(raw)

      expect(res.status).toBe(401)
    })

    it('refuses a callback addressed to a courier this shop does not use', async () => {
      const body = { trackingNumber: 'FAKE000001', events: [scan('delivered', '2026-08-02T14:30:00.000Z')] }
      const { raw, signature } = signFakeWebhook(body)

      const res = await request(app)
        .post('/api/v1/webhooks/carriers/someone-else')
        .set('Content-Type', 'application/json')
        .set('x-fake-signature', signature)
        .send(raw)

      expect(res.status).toBe(404)
    })

    it('accepts a signed callback about a parcel that is not ours, and does nothing', async () => {
      const body = {
        trackingNumber: 'NOT-OURS-1',
        events: [scan('delivered', '2026-08-02T14:30:00.000Z')],
      }
      const { raw, signature } = signFakeWebhook(body)

      const res = await request(app)
        .post('/api/v1/webhooks/carriers/fake')
        .set('Content-Type', 'application/json')
        .set('x-fake-signature', signature)
        .send(raw)

      expect(res.status).toBe(200)
      expect(res.body.data.applied).toBe(false)
    })
  })

  // ── COD reconciliation ────────────────────────────────────────────────────

  describe('cash on delivery reconciliation', () => {
    const statement = (filename = 'august.csv') => ({
      filename,
      content: Buffer.from('tracking,collected\n').toString('base64'),
    })

    async function shippedCodOrder(priceAmount = 5000) {
      const order = await codOrder(priceAmount)
      const shipment = await ship(order.orderId, order.itemId)
      return { ...order, shipmentId: shipment.id, trackingNumber: shipment.trackingNumber! }
    }

    it('matches a line whose amount agrees with the order', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: order.trackingNumber,
          collectedCents: order.totalCents,
          feeCents: 200,
          netCents: order.totalCents - 200,
          currency: order.currency,
          collectedAt: new Date('2026-08-03T00:00:00.000Z'),
          reference: 'REF-1',
        },
      ]

      const res = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-01',
      })

      expect(res.status).toBe(201)
      expect(res.body.data.totals).toMatchObject({ lines: 1, matched: 1, mismatched: 0, unmatched: 0 })

      const detail = await get(`/admin/shipping/cod/remittances/${res.body.data.id}`)
      expect(detail.body.data.lines[0]).toMatchObject({
        matchStatus: 'matched',
        orderId: order.orderId,
        expectedCents: order.totalCents,
        settled: false,
      })
    })

    it('flags a line that pays a different amount, and refuses to bank it', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: order.trackingNumber,
          // Short by a hundred: the finding this whole feature exists for.
          collectedCents: order.totalCents - 100,
          feeCents: 200,
          netCents: order.totalCents - 300,
          currency: order.currency,
          collectedAt: null,
          reference: null,
        },
      ]

      const imported = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-02',
      })
      expect(imported.body.data.totals.mismatched).toBe(1)

      const detail = await get(`/admin/shipping/cod/remittances/${imported.body.data.id}`)
      const line = detail.body.data.lines[0]
      expect(line).toMatchObject({ matchStatus: 'mismatched', expectedCents: order.totalCents })

      const settle = await post(`/admin/shipping/cod/lines/${line.id}/settle`)
      expect(settle.status).toBe(422)
      expect(settle.body.message).toMatch(/different amount/i)

      // And the order is still unpaid, which is the point.
      const row = await queryOne<{ payment_status: string }>(
        `SELECT payment_status FROM orders WHERE id = $1`,
        [order.orderId],
      )
      expect(row?.payment_status).toBe('pending')
    })

    it('records a line for a parcel nobody can account for', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: 'SOMEONE-ELSES-PARCEL',
          collectedCents: 1000,
          feeCents: 100,
          netCents: 900,
          currency: order.currency,
          collectedAt: null,
          reference: null,
        },
      ]

      const res = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-03',
      })
      expect(res.body.data.totals).toMatchObject({ unmatched: 1, matched: 0 })

      const detail = await get(`/admin/shipping/cod/remittances/${res.body.data.id}`)
      expect(detail.body.data.lines[0]).toMatchObject({
        matchStatus: 'unmatched',
        orderId: null,
        expectedCents: null,
      })
    })

    it('settles a matched line, which pays and completes the order', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: order.trackingNumber,
          collectedCents: order.totalCents,
          feeCents: 200,
          netCents: order.totalCents - 200,
          currency: order.currency,
          collectedAt: new Date('2026-08-03T00:00:00.000Z'),
          reference: 'REF-1',
        },
      ]
      const imported = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-04',
      })
      const detail = await get(`/admin/shipping/cod/remittances/${imported.body.data.id}`)
      const lineId = detail.body.data.lines[0].id

      const settled = await post(`/admin/shipping/cod/lines/${lineId}/settle`)
      expect(settled.status).toBe(200)
      expect(settled.body.data.amount.amount).toBe(order.totalCents)

      const row = await queryOne<{ payment_status: string }>(
        `SELECT payment_status FROM orders WHERE id = $1`,
        [order.orderId],
      )
      expect(row?.payment_status).toBe('paid')

      // The payment names the statement line it came off.
      const payment = await queryOne<{ provider: string; provider_payment_id: string }>(
        `SELECT provider, provider_payment_id FROM payments WHERE order_id = $1`,
        [order.orderId],
      )
      expect(payment).toMatchObject({ provider: 'carrier', provider_payment_id: lineId })
    })

    it('refuses to bank the same line twice', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: order.trackingNumber,
          collectedCents: order.totalCents,
          feeCents: 0,
          netCents: order.totalCents,
          currency: order.currency,
          collectedAt: null,
          reference: null,
        },
      ]
      const imported = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-05',
      })
      const detail = await get(`/admin/shipping/cod/remittances/${imported.body.data.id}`)
      const lineId = detail.body.data.lines[0].id

      await post(`/admin/shipping/cod/lines/${lineId}/settle`)
      const again = await post(`/admin/shipping/cod/lines/${lineId}/settle`)

      expect(again.status).toBe(422)
      expect(again.body.message).toMatch(/already been recorded/i)
    })

    it('refuses the same statement twice', async () => {
      const order = await shippedCodOrder()
      carrier.remittance = [
        {
          trackingNumber: order.trackingNumber,
          collectedCents: order.totalCents,
          feeCents: 0,
          netCents: order.totalCents,
          currency: order.currency,
          collectedAt: null,
          reference: null,
        },
      ]

      await post('/admin/shipping/cod/remittances', { ...statement(), reference: 'AUG-2026-06' })
      const again = await post('/admin/shipping/cod/remittances', {
        ...statement(),
        reference: 'AUG-2026-06',
      })

      expect(again.status).toBe(409)
      expect(again.body.message).toMatch(/already been imported/i)
    })

    it('refuses a file the courier’s adapter cannot read', async () => {
      const res = await post('/admin/shipping/cod/remittances', {
        filename: 'holiday-photo.jpg',
        content: Buffer.from('NOT-A-STATEMENT').toString('base64'),
      })

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/could not be read/i)
    })

    it('keeps a member of staff without capture rights out of the statements', async () => {
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      const res = await request(app)
        .post('/api/v1/admin/shipping/cod/remittances')
        .set('Authorization', bearer(staff.accessToken))
        .set('Idempotency-Key', crypto.randomUUID())
        .send(statement())

      expect(res.status).toBe(403)
    })
  })
})
