/**
 * Bank transfer, verified by hand (§5.7).
 *
 * The three things this suite exists to hold down:
 *
 *   **A proof is evidence, not money.** Nothing a customer types decides an
 *   amount. Approving records the order's own outstanding balance, and a
 *   receipt claiming a different figure changes nothing.
 *
 *   **The claim is scoped.** Order number *and* the email it was placed with,
 *   or a session that owns the order. Neither half alone reaches anything, and
 *   a registered customer's order is not reachable by guessing their email.
 *
 *   **A receipt awaiting review is not an abandoned order.** The unpaid sweep
 *   must leave it alone, or a customer who paid on Friday loses their order
 *   before anyone opens the queue on Monday.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { processImageHandler } from '../../src/jobs/media/processImage.job.js'
import { expireUnpaidOrdersHandler } from '../../src/jobs/orders/expireUnpaid.job.js'
import { createLogger } from '../../src/infrastructure/logging/logger.js'
import { queryOne } from '../../src/infrastructure/database/query.js'
import { usersService } from '../../src/features/users/index.js'
import { settingsService } from '../../src/features/settings/index.js'
import type { JobContext } from '../../src/infrastructure/queue/register.js'
import { QUEUES } from '../../src/infrastructure/queue/queues.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { makeJpeg } from '../factories/images.js'
import {
  addToCart,
  backdateOrder,
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
const storage = new MemoryStorageProvider('proof-test')

function jobContext(): JobContext {
  return {
    jobId: 'job-1',
    queue: QUEUES.MEDIA_PROCESS_IMAGE,
    attempt: 1,
    logger: createLogger('test'),
    signal: new AbortController().signal,
  }
}

describeIfDatabase('bank transfer', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string

  const admin = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const adminPost = (path: string, body: object = {}) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', `k-${Math.random()}`)
      .send(body)

  const BANK = {
    bankTransferEnabled: true,
    bankAccountName: 'Copperleaf Trading Ltd',
    bankName: 'Example Bank',
    bankAccountNumber: '12345678',
    bankInstructions: 'Quote your order number as the reference.',
  }

  beforeAll(async () => {
    await setupDatabase()
    setStorage(storage)
  })
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
    await setSettings(BANK)
  })
  afterEach(async () => {
    usersService.clearCaches()
    settingsService.invalidate()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** An order placed to be paid by bank transfer, as a guest. */
  async function bankOrder(email = 'payer@example.test') {
    const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const res = await checkout(shopper, {
      shippingMethodId: methodId,
      email,
      paymentMethod: 'bank_transfer',
    })
    if (res.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(res.body)}`)
    return {
      id: res.body.data.id as string,
      orderNumber: res.body.data.orderNumber as string,
      email,
      total: res.body.data.totals.total.amount as number,
    }
  }

  const claim = (order: { orderNumber: string; email: string }) => ({
    orderNumber: order.orderNumber,
    email: order.email,
  })

  /** The whole customer-side upload: ticket, bytes, complete, process. */
  async function uploadReceipt(order: { orderNumber: string; email: string }) {
    const ticket = await request(app)
      .post('/api/v1/storefront/payments/bank-transfer/uploads')
      .send({ ...claim(order), contentType: 'image/jpeg', byteSize: 2048 })
    expect(ticket.status).toBe(202)

    await storage.completeUpload(ticket.body.data.upload.token, await makeJpeg(), 'image/jpeg')

    const done = await request(app)
      .post('/api/v1/storefront/payments/bank-transfer/uploads/complete')
      .send({ ...claim(order), assetId: ticket.body.data.assetId })
    expect(done.status).toBe(202)

    // The worker is mocked out, so run the processing inline: a proof cannot be
    // submitted against an asset that never reached `ready`.
    await processImageHandler({ mediaAssetId: ticket.body.data.assetId }, jobContext())
    return ticket.body.data.assetId as string
  }

  const submit = (order: { orderNumber: string; email: string }, mediaId: string, extra = {}) =>
    request(app)
      .post('/api/v1/storefront/payments/bank-transfer/proofs')
      .send({
        ...claim(order),
        mediaId,
        senderName: 'Ada Lovelace',
        senderBank: 'Example Bank',
        ...extra,
      })

  // ── Offering the method at all ────────────────────────────────────────────

  describe('whether it is on offer', () => {
    it('is refused while the shop has it switched off', async () => {
      await setSettings({ bankTransferEnabled: false })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)

      const res = await checkout(shopper, {
        shippingMethodId: methodId,
        paymentMethod: 'bank_transfer',
      })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE')
    })

    it('cannot be switched on without an account to pay into', async () => {
      // The database refuses it, so the storefront can never render an empty
      // panel telling somebody to transfer money to nowhere.
      const res = await request(app)
        .patch('/api/v1/admin/settings')
        .set('Authorization', bearer(owner.accessToken))
        .send({ bankTransferEnabled: true, bankAccountName: null, bankName: null })

      expect(res.status).toBeGreaterThanOrEqual(400)
    })

    it('tells the storefront it is available, without publishing the account', async () => {
      const res = await request(app).get('/api/v1/storefront/settings')

      expect(res.body.data.bankTransferEnabled).toBe(true)
      // The account belongs with the order that is to be paid, not on a public
      // endpoint anybody can read without buying anything.
      expect(JSON.stringify(res.body.data)).not.toMatch(/12345678/)
    })

    it('leaves the order unpaid and pending when one is placed', async () => {
      const order = await bankOrder()
      const detail = await admin(`/admin/orders/${order.id}`)

      expect(detail.body.data.paymentStatus).toBe('pending')
      expect(detail.body.data.status).toBe('pending')
    })
  })

  // ── The customer's side ───────────────────────────────────────────────────

  describe('paying', () => {
    it('shows where to send the money, to whoever holds the order', async () => {
      const order = await bankOrder()

      const res = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer')
        .send(claim(order))

      expect(res.status).toBe(200)
      expect(res.body.data.bankDetails).toMatchObject({
        accountName: 'Copperleaf Trading Ltd',
        bankName: 'Example Bank',
        accountNumber: '12345678',
      })
      expect(res.body.data.order.total.amount).toBe(order.total)
    })

    it('needs both the number and the email', async () => {
      const order = await bankOrder()

      const wrongEmail = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer')
        .send({ orderNumber: order.orderNumber, email: 'someone.else@example.test' })
      const wrongNumber = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer')
        .send({ orderNumber: '#999999', email: order.email })

      expect(wrongEmail.status).toBe(404)
      expect(wrongNumber.status).toBe(404)
      // Identical, so this cannot be used to learn which numbers exist.
      expect(wrongEmail.body.message).toBe(wrongNumber.body.message)
    })

    it('accepts a receipt and puts it in the queue', async () => {
      const order = await bankOrder()
      const mediaId = await uploadReceipt(order)

      const res = await submit(order, mediaId, { accountLast4: '4321' })

      expect(res.status).toBe(201)
      expect(res.body.data.status).toBe('submitted')

      const queue = await admin('/admin/payments/proofs?status=submitted')
      expect(queue.body.data).toHaveLength(1)
      expect(queue.body.data[0]).toMatchObject({
        claim: { senderName: 'Ada Lovelace', accountLast4: '4321' },
        order: { orderNumber: order.orderNumber },
      })
      // The reviewer has something to look at.
      expect(queue.body.data[0].imageUrl).toBeTruthy()
    })

    it('refuses a second receipt while one is still waiting', async () => {
      const order = await bankOrder()
      const first = await uploadReceipt(order)
      await submit(order, first, {})
      const second = await uploadReceipt(order)

      const res = await submit(order, second, {})

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('ALREADY_EXISTS')
    })

    it('refuses a receipt for an order that was not placed this way', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const cod = await checkout(shopper, { shippingMethodId: methodId, paymentMethod: 'cod' })
      const order = {
        orderNumber: cod.body.data.orderNumber as string,
        email: 'buyer@example.test',
      }

      const mediaId = await uploadReceipt(order)
      const res = await submit(order, mediaId, {})

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/not placed to be paid by bank transfer/i)
    })

    it('refuses an image that never finished uploading', async () => {
      const order = await bankOrder()
      const ticket = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer/uploads')
        .send({ ...claim(order), contentType: 'image/jpeg', byteSize: 2048 })

      // No bytes, no complete, no processing: the asset is still `pending`.
      const res = await submit(order, ticket.body.data.assetId, {})

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/has not finished uploading/i)
    })

    it('does not let one order’s claim upload against another', async () => {
      const mine = await bankOrder('mine@example.test')
      const theirs = await bankOrder('theirs@example.test')

      const res = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer/uploads')
        .send({
          orderNumber: theirs.orderNumber,
          email: mine.email,
          contentType: 'image/jpeg',
          byteSize: 2048,
        })

      expect(res.status).toBe(404)
    })
  })

  // ── The shop's side ───────────────────────────────────────────────────────

  describe('reviewing', () => {
    async function pendingProof() {
      const order = await bankOrder()
      const mediaId = await uploadReceipt(order)
      const submitted = await submit(order, mediaId, {})
      return { order, proofId: submitted.body.data.id as string }
    }

    it('approving records the money and confirms the order', async () => {
      const { order, proofId } = await pendingProof()

      const res = await adminPost(`/admin/payments/proofs/${proofId}/approve`)

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('approved')
      expect(res.body.data.paymentId).toBeTruthy()

      const detail = await admin(`/admin/orders/${order.id}`)
      expect(detail.body.data.paymentStatus).toBe('paid')
      expect(detail.body.data.status).toBe('confirmed')

      const payments = await admin(`/admin/orders/${order.id}/payments`)
      expect(payments.body.data.payments).toHaveLength(1)
      expect(payments.body.data.payments[0]).toMatchObject({
        method: 'bank_transfer',
        status: 'paid',
        amount: { amount: order.total },
      })
    })

    it('records the order’s own total, whatever the customer claimed', async () => {
      // The point of the whole design. There is no field on the submission that
      // can influence this number, and there must never be one.
      const { order, proofId } = await pendingProof()

      await adminPost(`/admin/payments/proofs/${proofId}/approve`)

      const payments = await admin(`/admin/orders/${order.id}/payments`)
      expect(payments.body.data.payments[0].amount.amount).toBe(order.total)
    })

    it('rejecting leaves the order unpaid and says why', async () => {
      const { order, proofId } = await pendingProof()

      const res = await adminPost(`/admin/payments/proofs/${proofId}/reject`, {
        note: 'The amount does not match your order total.',
      })

      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('rejected')

      const detail = await admin(`/admin/orders/${order.id}`)
      expect(detail.body.data.paymentStatus).toBe('pending')

      // And the customer can read the reason, which is the only part they can
      // act on.
      const view = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer')
        .send(claim(order))
      expect(view.body.data.proofs[0]).toMatchObject({
        status: 'rejected',
        reviewNote: 'The amount does not match your order total.',
      })
    })

    it('will not reject without a reason', async () => {
      const { proofId } = await pendingProof()
      const res = await adminPost(`/admin/payments/proofs/${proofId}/reject`, { note: '   ' })
      expect(res.status).toBe(422)
    })

    it('lets the customer try again after a rejection', async () => {
      const { order, proofId } = await pendingProof()
      await adminPost(`/admin/payments/proofs/${proofId}/reject`, { note: 'Wrong account.' })

      const mediaId = await uploadReceipt(order)
      const res = await submit(order, mediaId, {})

      expect(res.status).toBe(201)
    })

    it('cannot be approved twice', async () => {
      const { proofId } = await pendingProof()
      await adminPost(`/admin/payments/proofs/${proofId}/approve`)

      const again = await adminPost(`/admin/payments/proofs/${proofId}/approve`)

      // One payment, not two — the money is the thing that must not double.
      expect(again.status).toBe(409)
    })

    it('hides the reviewer from the customer', async () => {
      const { order, proofId } = await pendingProof()
      await adminPost(`/admin/payments/proofs/${proofId}/reject`, { note: 'Illegible.' })

      const view = await request(app)
        .post('/api/v1/storefront/payments/bank-transfer')
        .send(claim(order))

      const body = JSON.stringify(view.body.data)
      expect(body).not.toMatch(owner.user.email)
      expect(body).not.toMatch(/reviewedBy/)
    })

    it('needs payments:capture to decide, not merely to look', async () => {
      const { proofId } = await pendingProof()
      const reader = await createUserAndLogin(app, { roles: ['staff'] })
      // Staff hold payments:read but not payments:capture.
      const res = await request(app)
        .post(`/api/v1/admin/payments/proofs/${proofId}/approve`)
        .set('Authorization', bearer(reader.accessToken))
        .set('Idempotency-Key', 'k-1')
        .send({})

      expect(res.status).toBe(403)
    })
  })

  // ── The ledger ────────────────────────────────────────────────────────────

  describe('the payments index', () => {
    it('lists payments across every order', async () => {
      const { proofId } = await (async () => {
        const order = await bankOrder()
        const mediaId = await uploadReceipt(order)
        const submitted = await submit(order, mediaId, {})
        return { proofId: submitted.body.data.id as string }
      })()
      await adminPost(`/admin/payments/proofs/${proofId}/approve`)

      const res = await admin('/admin/payments?method=bank_transfer')

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      // Readable on its own: an amount with no order number beside it is not a
      // row anybody can reconcile.
      expect(res.body.data[0]).toMatchObject({ method: 'bank_transfer', status: 'paid' })
      expect(res.body.data[0].orderNumber).toBeTruthy()
    })
  })

  // ── The sweep ─────────────────────────────────────────────────────────────

  describe('the unpaid-order sweep', () => {
    const sweep = () =>
      expireUnpaidOrdersHandler(
        { afterHours: 1, codAcceptanceHours: 240, batchSize: 50 },
        { ...jobContext(), queue: QUEUES.ORDER_EXPIRE_UNPAID as JobContext['queue'] },
      )

    /** Ages an order past the sweep window without waiting an hour. */
    const age = (orderId: string) => backdateOrder(orderId, 3)

    it('leaves an order alone while its receipt is waiting to be reviewed', async () => {
      const order = await bankOrder()
      const mediaId = await uploadReceipt(order)
      await submit(order, mediaId, {})
      await age(order.id)

      await sweep()

      const row = await queryOne<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      )
      // Otherwise somebody who paid on Friday evening loses their order before
      // anyone opens the queue on Monday.
      expect(row?.status).toBe('pending')
    })

    it('still cancels one where nothing was ever sent', async () => {
      const order = await bankOrder()
      await age(order.id)

      await sweep()

      const row = await queryOne<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      )
      expect(row?.status).toBe('cancelled')
    })

    it('resumes cancelling once a receipt has been rejected', async () => {
      const order = await bankOrder()
      const mediaId = await uploadReceipt(order)
      const submitted = await submit(order, mediaId, {})
      await adminPost(`/admin/payments/proofs/${submitted.body.data.id}/reject`, {
        note: 'Not our account.',
      })
      await age(order.id)

      await sweep()

      const row = await queryOne<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      )
      expect(row?.status).toBe('cancelled')
    })
  })
})
