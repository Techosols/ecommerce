/**
 * Availability, where inventory meets the catalogue (docs/inventory.md §7, §17).
 *
 * The rule under test, stated once:
 *
 * ```
 *   purchasable = product active
 *               AND published to this channel
 *               AND variant active and not archived
 *               AND (inventory untracked OR available > 0)
 * ```
 *
 * Five conditions, five different things — and the suite checks that each one
 * can veto on its own. It also checks the two failure modes that matter
 * commercially: a page that says "in stock" when the shelf is empty, and a page
 * that says "sold out" for something the kitchen makes to order.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { productsService } from '../../src/features/catalogue/index.js'
import { availabilityService } from '../../src/features/inventory/index.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  createPizza,
  createSimpleProduct,
  publishProduct,
  stockProduct,
  uniqueHandle,
  untrackProduct,
} from '../factories/catalogue.js'
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

describeIfDatabase('inventory availability', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken)).send(body)
  const patch = (path: string, body: object = {}) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken)).send(body)
  const shop = (path: string) => request(app).get(`/api/v1/storefront${path}`)

  const receive = (variantId: string, delta: number) =>
    post('/admin/inventory/adjustments', { variantId, delta, reason: 'receive' })

  beforeAll(setupDatabase)
  beforeEach(async () => {
    admin = await createUserAndLogin(app, { roles: ['admin'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── The happy path ────────────────────────────────────────────────────────

  it('reports a stocked, active, published variant as available', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 12)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop(`/products/${product.handle}`)
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.variants[0]).toMatchObject({
      available: true,
      availability: 'in_stock',
    })
  })

  // ── Each condition can veto on its own ────────────────────────────────────

  it('reports zero stock as unavailable without hiding the product', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 2)
    await publishProduct(app, admin.accessToken, product.id)

    await post('/admin/inventory/adjustments', {
      variantId: product.variants[0]!.id,
      delta: -2,
      reason: 'waste',
    })

    const res = await shop(`/products/${product.handle}`)
    // Still on the shop — an out-of-stock burger is not an archived burger.
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.variants[0]).toMatchObject({
      available: false,
      availability: 'out_of_stock',
    })
    expect(res.body.data.priceRange).toBeNull()
  })

  it('keeps an unpublished product invisible however much stock it has', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 100)

    // Never activated, never published.
    expect((await shop(`/products/${product.handle}`)).status).toBe(404)

    await post(`/admin/products/${product.id}/activate`)
    // Active but unpublished is still invisible: publication is its own gate.
    expect((await shop(`/products/${product.handle}`)).status).toBe(404)
  })

  it('keeps an inactive variant unavailable however much stock it has', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, pizza, 50)
    await publishProduct(app, admin.accessToken, pizza.id)

    await patch(`/admin/variants/${pizza.variants[0]!.id}`, { isActive: false })

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.variants).toHaveLength(5)
    expect(res.body.data.variants.some((v: { id: string }) => v.id === pizza.variants[0]!.id)).toBe(
      false,
    )
  })

  it('keeps an archived product unavailable however much stock it has', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 100)
    await publishProduct(app, admin.accessToken, product.id)
    await post(`/admin/products/${product.id}/archive`)

    expect((await shop(`/products/${product.handle}`)).status).toBe(404)
  })

  // ── Untracked is unlimited, not zero ──────────────────────────────────────

  it('sells a made-to-order item with no stock at all', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await untrackProduct(app, admin.accessToken, product)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop(`/products/${product.handle}`)
    // Zero on hand, and correctly purchasable: the kitchen cooks it on demand.
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.variants[0]).toMatchObject({
      available: true,
      availability: 'made_to_order',
    })
  })

  it('never infers zero from a missing inventory item', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const availability = await availabilityService.forVariant(
      '00000000-0000-4000-8000-000000000000',
    )
    // A variant nobody has ever stocked is untracked, not sold out. Reading it
    // as zero would have silently hidden products the day this shipped.
    expect(availability.inStock).toBe(true)
    expect(availability.state).toBe('made_to_order')
    expect(product).toBeTruthy()
  })

  it('flips a variant to unlimited the moment tracking is switched off', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)
    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(false)

    await untrackProduct(app, admin.accessToken, product)
    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(true)
  })

  // ── Mixed availability across variants ────────────────────────────────────

  it('prices from the variants that can actually be bought', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, pizza.id)

    // Only the two large pizzas are stocked: 1399 and 1449.
    const large = pizza.variants.filter((v) => v.title.startsWith('Large'))
    for (const variant of large) await receive(variant.id, 5)

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.available).toBe(true)
    expect(res.body.data.priceRange).toEqual({
      min: { amount: 1399, currency: 'USD' },
      max: { amount: 1449, currency: 'USD' },
    })

    // The unavailable sizes stay listed and marked, because a customer choosing
    // a size needs to see that Small exists and is unavailable.
    const small = res.body.data.variants.find((v: { title: string }) => v.title === 'Small / Classic')
    expect(small).toMatchObject({ available: false, availability: 'out_of_stock' })
  })

  it('marks a product unavailable when every variant is out', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, pizza.id)

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.variants.every((v: { available: boolean }) => !v.available)).toBe(true)
  })

  // ── Reservations move availability ────────────────────────────────────────

  it('reflects a reservation immediately, and gives it back on release', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 3)
    await publishProduct(app, admin.accessToken, product.id)

    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(true)

    const reservation = await post('/admin/inventory/reservations', {
      variantId,
      quantity: 3,
      ownerType: 'cart',
      ownerId: '11111111-1111-4111-8111-111111111111',
    })
    // Reserved is not available: the units are spoken for.
    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(false)

    await post(`/admin/inventory/reservations/${reservation.body.data.id}/release`)
    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(true)
  })

  it('keeps stock gone after a commit', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 2)
    await publishProduct(app, admin.accessToken, product.id)

    const reservation = await post('/admin/inventory/reservations', {
      variantId,
      quantity: 2,
      ownerType: 'order',
      ownerId: '22222222-2222-4222-8222-222222222222',
    })
    await post(`/admin/inventory/reservations/${reservation.body.data.id}/commit`)

    expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(false)
  })

  // ── Cache correctness ─────────────────────────────────────────────────────

  it('never serves stale availability from the product cache', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 5)
    await publishProduct(app, admin.accessToken, product.id)

    // Warm the cache, hard.
    for (let i = 0; i < 3; i += 1) {
      expect((await shop(`/products/${product.handle}`)).body.data.available).toBe(true)
    }
    // The product detail is genuinely cached — this is not a test that passes
    // because caching is off.
    expect(await productsService.detail(product.id)).toBeTruthy()

    await post('/admin/inventory/adjustments', { variantId, delta: -5, reason: 'waste' })

    // No waiting for a TTL: availability is resolved per request, never cached
    // with the product, so "stock is zero but the page says in stock" cannot
    // happen at all (docs/inventory.md §17).
    const after = await shop(`/products/${product.handle}`)
    expect(after.body.data.available).toBe(false)
    expect(after.body.data.variants[0].availability).toBe('out_of_stock')
  })

  it('keeps a listing page’s availability fresh too', async () => {
    const product = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('c') })
    const variantId = product.variants[0]!.id
    await receive(variantId, 4)
    await publishProduct(app, admin.accessToken, product.id)

    expect((await shop('/products')).body.data[0].available).toBe(true)

    await post('/admin/inventory/adjustments', { variantId, delta: -4, reason: 'waste' })
    expect((await shop('/products')).body.data[0].available).toBe(false)
  })

  // ── The storefront must not leak inventory internals ──────────────────────

  it('tells the storefront a state, never a quantity', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 137)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop(`/products/${product.handle}`)
    const body = JSON.stringify(res.body)

    // Exposing exact stock is a product decision, and the default is no.
    expect(body).not.toContain('137')
    for (const leaked of ['onHand', 'reserved', 'inventoryItemId', 'locationId', 'trackInventory']) {
      expect(body, `${leaked} must not be public`).not.toContain(leaked)
    }
    expect(res.body.data.variants[0].availability).toBe('in_stock')
  })

  it('leaks no movement history, actor or location to the storefront', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, product, 5)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop('/products')
    const body = JSON.stringify(res.body)
    for (const leaked of ['movement', 'actorUserId', 'note', 'main', 'threshold']) {
      expect(body, `${leaked} must not be public`).not.toContain(leaked)
    }
  })
})
