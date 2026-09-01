/**
 * Draft orders (§8.4).
 *
 * A draft is an order staff build by hand: a row in `orders` with status
 * `draft`, assembled over several requests and quoted at every step. Four
 * properties this suite exists to hold down, because each of them is a way the
 * feature could quietly go wrong and still look right on screen:
 *
 *   **A draft holds no stock.** Reserving on a quote would let a phone call
 *   empty the shelf. The reservation is taken at placement, in checkout's own
 *   transaction, exactly as a storefront checkout takes it.
 *
 *   **A draft is not a sale.** It must not appear in the order list, in
 *   revenue, in a customer's history, or in the queue of orders to pack —
 *   until it is placed, at which point the *placed order* appears and the
 *   draft still does not.
 *
 *   **A draft is priced by checkout, not beside it.** The quote runs
 *   `checkoutService.preview` over the draft's lines, so the figure a staff
 *   member reads down the phone is the figure the customer is charged.
 *
 *   **Placing one runs the ordinary checkout.** Not a second write path with
 *   its own idea of stock and totals — the same function, over the same
 *   basket, producing a real order.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  GB_ADDRESS,
  createDiscount,
  createShippingMethod,
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

describeIfDatabase('draft orders', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let variantId: string
  let productId: string

  const auth = (req: request.Test, token?: string) =>
    req.set('Authorization', bearer(token ?? owner.accessToken))

  const post = (path: string, body?: object, token?: string) =>
    auth(request(app).post(`/api/v1${path}`), token).send(body ?? {})
  const get = (path: string, token?: string) => auth(request(app).get(`/api/v1${path}`), token)
  const patch = (path: string, body: object, token?: string) =>
    auth(request(app).patch(`/api/v1${path}`), token).send(body)
  const put = (path: string, body: object, token?: string) =>
    auth(request(app).put(`/api/v1${path}`), token).send(body)
  const del = (path: string, token?: string) => auth(request(app).delete(`/api/v1${path}`), token)

  /** A draft with lines, an email and an address — everything but the placing. */
  const readyDraft = async (units = 2) => {
    const created = await post('/admin/drafts', { email: 'phone@example.test' })
    expect(created.status).toBe(201)
    const id = created.body.data.id as string

    await put(`/admin/drafts/${id}/lines`, { lines: [{ variantId, quantity: units }] })
    const quoted = await patch(`/admin/drafts/${id}`, {
      shippingAddress: GB_ADDRESS,
      shippingMethodId: methodId,
      paymentMethod: 'manual',
    })
    expect(quoted.status).toBe(200)
    return { id, quote: quoted.body.data }
  }

  const stockOf = async (variant: string) =>
    (
      await queryOne<{ on_hand: number; reserved: number }>(
        `SELECT COALESCE(SUM(l.on_hand),0)::int AS on_hand,
                COALESCE(SUM(l.reserved),0)::int AS reserved
           FROM inventory_levels l
           JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE i.variant_id = $1`,
        [variant],
      )
    ) as { on_hand: number; reserved: number }

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 }))
    const product = await sellableProduct(app, owner.accessToken, {
      priceAmount: 5000,
      quantity: 10,
    })
    productId = product.id
    variantId = product.variants[0]!.id
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Building one ──────────────────────────────────────────────────────────

  describe('building a draft', () => {
    it('starts empty, and says what is missing rather than refusing to answer', async () => {
      const created = await post('/admin/drafts', {})

      expect(created.status).toBe(201)
      const quote = await get(`/admin/drafts/${created.body.data.id}`)

      expect(quote.status).toBe(200)
      expect(quote.body.data.blockers).toEqual([
        'Add at least one product.',
        'Add an email address to send the order to.',
        'Add a delivery address.',
      ])
    })

    it('does not take an order number from the sequence', async () => {
      // A draft that is discarded would burn one, and a shop counting its
      // orders by number should not see gaps for quotes nobody placed.
      const created = await post('/admin/drafts', {})

      expect(created.body.data.reference).toMatch(/^DRAFT-/)
    })

    it('replaces the whole line list rather than diffing it', async () => {
      const { id } = await readyDraft(2)

      await put(`/admin/drafts/${id}/lines`, { lines: [{ variantId, quantity: 5 }] })
      const quote = await get(`/admin/drafts/${id}`)

      expect(quote.body.data.lines).toHaveLength(1)
      expect(quote.body.data.lines[0].quantity).toBe(5)
      expect(quote.body.data.subtotal.amount).toBe(25_000)
    })

    it('merges a variant listed twice instead of storing it twice', async () => {
      const created = await post('/admin/drafts', {})
      const id = created.body.data.id

      await put(`/admin/drafts/${id}/lines`, {
        lines: [
          { variantId, quantity: 2 },
          { variantId, quantity: 3 },
        ],
      })
      const quote = await get(`/admin/drafts/${id}`)

      expect(quote.body.data.lines).toHaveLength(1)
      expect(quote.body.data.lines[0].quantity).toBe(5)
    })

    it('follows the catalogue price rather than remembering one', async () => {
      // Same rule as a cart: the draft stores a reference and a quantity, so a
      // quote reopened tomorrow is worth what it would cost tomorrow.
      const { id } = await readyDraft(2)
      await execute(`UPDATE product_variants SET price_amount = 6000 WHERE id = $1`, [variantId])

      const quote = await get(`/admin/drafts/${id}`)

      expect(quote.body.data.subtotal.amount).toBe(12_000)
    })

    it('finds variants to add, priced from the catalogue', async () => {
      const title = (await get(`/admin/products/${productId}`)).body.data.title as string

      const found = await get(`/admin/drafts/variant-search?q=${encodeURIComponent(title)}`)

      expect(found.status).toBe(200)
      const row = found.body.data.find((r: { variantId: string }) => r.variantId === variantId)
      expect(row).toBeDefined()
      expect(row.price.amount).toBe(5000)
    })
  })

  // ── What a draft is not ───────────────────────────────────────────────────

  describe('a draft is not a sale', () => {
    it('reserves no stock while it is being built', async () => {
      const before = await stockOf(variantId)
      await readyDraft(4)
      const after = await stockOf(variantId)

      expect(after.reserved).toBe(before.reserved)
      expect(after.on_hand).toBe(before.on_hand)
    })

    it('stays out of the order list', async () => {
      await readyDraft()

      const orders = await get('/admin/orders')

      expect(orders.body.data).toHaveLength(0)
    })

    it('stays out of the customer record and out of revenue', async () => {
      const customer = await createUserAndLogin(app, { roles: ['customer'] })
      const created = await post('/admin/drafts', {
        customerId: customer.user.id,
        email: 'phone@example.test',
      })
      await put(`/admin/drafts/${created.body.data.id}/lines`, {
        lines: [{ variantId, quantity: 3 }],
      })

      const [record, dashboard] = await Promise.all([
        get(`/admin/customers/${customer.user.id}`),
        get('/admin/analytics/dashboard'),
      ])

      expect(record.body.data.ordersCount).toBe(0)
      expect(record.body.data.totalSpent.amount).toBe(0)
      expect(dashboard.body.data.today.ordersCount).toBe(0)
      expect(dashboard.body.data.counters.awaitingPayment).toBe(0)
    })

    it('cannot be moved along by a status change', async () => {
      // Placing is a different operation from a status update: it reserves
      // stock and assigns the moment of sale. Offering `draft → pending` here
      // would be a way to skip both.
      const { id } = await readyDraft()

      const moved = await post(`/admin/orders/${id}/transitions`, { status: 'confirmed' })

      expect(moved.status).toBe(422)
    })
  })

  // ── Quoting ───────────────────────────────────────────────────────────────

  describe('the quote', () => {
    it('prices delivery, tax and the total through checkout, not beside it', async () => {
      await setSettings({ taxRateBps: 1000, pricesIncludeTax: false })
      const { quote } = await readyDraft(2)

      expect(quote.subtotal.amount).toBe(10_000)
      expect(quote.shippingTotal.amount).toBe(499)
      expect(quote.taxTotal.amount).toBe(1000)
      expect(quote.total.amount).toBe(11_499)
    })

    it('offers the delivery options that apply to this address', async () => {
      const { quote } = await readyDraft()

      expect(quote.shippingOptions).toHaveLength(1)
      expect(quote.shippingOptions[0]).toMatchObject({ methodId, name: 'Standard' })
    })

    it('offers staff the manual method a shopper may never pick', async () => {
      const { quote } = await readyDraft()

      const keys = quote.paymentMethods.map((method: { key: string }) => method.key)
      expect(keys).toContain('manual')
    })

    it('applies a discount code and shows what it is worth', async () => {
      const { code } = await createDiscount(app, owner.accessToken, { type: 'percentage', value: 2500 })
      const { id } = await readyDraft(2)

      const quoted = await patch(`/admin/drafts/${id}`, { discountCode: code })

      expect(quoted.body.data.discountTotal.amount).toBe(2500)
      expect(quoted.body.data.total.amount).toBe(10_000 - 2500 + 499)
    })

    it('turns a bad code into a blocker rather than a broken screen', async () => {
      const { id } = await readyDraft()

      const quoted = await patch(`/admin/drafts/${id}`, { discountCode: 'NOTACODE' })

      expect(quoted.status).toBe(200)
      expect(quoted.body.data.blockers.join(' ')).toMatch(/code/i)
    })

    it('reports a line that has since sold out', async () => {
      const { id } = await readyDraft(2)
      await execute(
        `UPDATE products SET status = 'archived', archived_at = now() WHERE id = $1`,
        [productId],
      )

      const quote = await get(`/admin/drafts/${id}`)

      expect(quote.body.data.purchasable).toBe(false)
      expect(quote.body.data.blockers.join(' ')).toMatch(/cannot be bought/i)
    })

    it('will not call it ready while no delivery option is chosen', async () => {
      // Checkout refuses an order that ships with no method on it, so the
      // blockers have to say so. A button the server will reject is worse
      // than no button.
      const created = await post('/admin/drafts', { email: 'phone@example.test' })
      const id = created.body.data.id
      await put(`/admin/drafts/${id}/lines`, { lines: [{ variantId, quantity: 1 }] })
      const quoted = await patch(`/admin/drafts/${id}`, { shippingAddress: GB_ADDRESS })

      expect(quoted.body.data.blockers).toContain('Choose a delivery option.')

      const placed = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )
      expect(placed.status).toBe(422)
    })

    it('says so when nothing at all can be delivered to that address', async () => {
      const created = await post('/admin/drafts', { email: 'phone@example.test' })
      const id = created.body.data.id
      await put(`/admin/drafts/${id}/lines`, { lines: [{ variantId, quantity: 1 }] })

      // Nowhere ships to Japan: the store has one zone, and it is GB.
      const quoted = await patch(`/admin/drafts/${id}`, {
        shippingAddress: { ...GB_ADDRESS, countryCode: 'JP' },
      })

      expect(quoted.body.data.blockers.join(' ')).toMatch(/Nothing can be delivered/)
    })

    it('quotes nothing before there is an address to quote against', async () => {
      // Delivery is rated against a country. Inventing one to fill the screen
      // would put a number in front of staff that checkout has not agreed to.
      const created = await post('/admin/drafts', { email: 'phone@example.test' })
      await put(`/admin/drafts/${created.body.data.id}/lines`, {
        lines: [{ variantId, quantity: 1 }],
      })

      const quote = await get(`/admin/drafts/${created.body.data.id}`)

      expect(quote.body.data.shippingTotal.amount).toBe(0)
      expect(quote.body.data.shippingOptions).toEqual([])
    })
  })

  // ── Placing ───────────────────────────────────────────────────────────────

  describe('placing a draft', () => {
    it('produces a real order, reserves the stock, and charges the quote', async () => {
      const before = await stockOf(variantId)
      const { id, quote } = await readyDraft(2)

      const placed = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      expect(placed.status).toBe(201)
      expect(placed.body.data.status).toBe('pending')
      expect(placed.body.data.orderNumber).not.toMatch(/^DRAFT-/)
      expect(placed.body.data.totals.total.amount).toBe(quote.total.amount)
      expect(placed.body.data.source).toBe('admin')

      const after = await stockOf(variantId)
      expect(after.reserved).toBe(before.reserved + 2)
    })

    it('leaves the draft behind, pointing at the order it became', async () => {
      const { id } = await readyDraft()

      const placed = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      const draft = await get(`/admin/drafts/${id}`)
      expect(draft.body.data.placedOrderId).toBe(placed.body.data.id)
      expect(draft.body.data.placedFromDraftAt).not.toBeNull()
    })

    it('shows the placed order in the list, and still not the draft', async () => {
      const { id } = await readyDraft()
      await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      const orders = await get('/admin/orders')

      expect(orders.body.data).toHaveLength(1)
      expect(orders.body.data[0].id).not.toBe(id)
    })

    it('refuses while anything is still missing', async () => {
      const created = await post('/admin/drafts', {})
      await put(`/admin/drafts/${created.body.data.id}/lines`, {
        lines: [{ variantId, quantity: 1 }],
      })

      const placed = await post(
        `/admin/drafts/${created.body.data.id}/place`,
        {},
        owner.accessToken,
      ).set('Idempotency-Key', idempotencyKey())

      expect(placed.status).toBe(422)
      expect(placed.body.message).toMatch(/email/i)
    })

    it('refuses to place the same draft twice', async () => {
      const { id } = await readyDraft()
      await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      const again = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      expect(again.status).toBe(422)
      expect(again.body.message).toMatch(/already been placed/i)
    })

    it('does not reserve twice when the button is double-clicked', async () => {
      const before = await stockOf(variantId)
      const { id } = await readyDraft(3)
      const key = idempotencyKey()

      const first = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        key,
      )
      const second = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        key,
      )

      expect(second.body.data.id).toBe(first.body.data.id)
      const after = await stockOf(variantId)
      expect(after.reserved).toBe(before.reserved + 3)
    })

    it('fails rather than overselling a line that sold out while it was open', async () => {
      const { id } = await readyDraft(4)
      await execute(
        `UPDATE inventory_levels SET on_hand = 1
           WHERE inventory_item_id IN (SELECT id FROM inventory_items WHERE variant_id = $1)`,
        [variantId],
      )

      const placed = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      expect(placed.status).toBeGreaterThanOrEqual(400)
      const stock = await stockOf(variantId)
      expect(stock.reserved).toBe(0)
    })

    it('applies the store money rules to staff as well', async () => {
      // `manual` is a method a shopper may not pick; the COD ceiling is a rule
      // about the shop's money and binds whoever is typing.
      await setSettings({ codEnabled: true, codMaxSubtotalCents: 5000 })
      const { id } = await readyDraft(4)
      await patch(`/admin/drafts/${id}`, { paymentMethod: 'cod' })

      const placed = await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      expect(placed.status).toBe(422)
      expect(placed.body.message).toMatch(/maximum/i)
    })
  })

  // ── Discarding, and who may do any of it ──────────────────────────────────

  describe('discarding', () => {
    it('removes a draft that was never placed', async () => {
      const { id } = await readyDraft()

      const discarded = await del(`/admin/drafts/${id}`)

      expect(discarded.status).toBe(204)
      expect((await get(`/admin/drafts/${id}`)).status).toBe(404)
    })

    it('refuses to discard one that has become an order', async () => {
      const { id } = await readyDraft()
      await post(`/admin/drafts/${id}/place`, {}, owner.accessToken).set(
        'Idempotency-Key',
        idempotencyKey(),
      )

      const discarded = await del(`/admin/drafts/${id}`)

      expect(discarded.status).toBe(422)
    })
  })

  describe('authorisation', () => {
    it('lets staff build one', async () => {
      // Building a draft is `orders:write` — the same authority as changing an
      // order, because a draft becomes a real sale.
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const built = await post('/admin/drafts', {}, staff.accessToken)

      expect(built.status).toBe(201)
    })

    it('shows a customer nothing at all', async () => {
      const customer = await createUserAndLogin(app, { roles: ['customer'] })

      const listed = await get('/admin/drafts', customer.accessToken)

      expect(listed.status).toBe(403)
    })

    it('records who quoted it', async () => {
      const { id } = await readyDraft()

      const draft = await get(`/admin/drafts/${id}`)

      expect(draft.body.data.draftedBy).toBe(owner.user.id)
    })
  })
})
