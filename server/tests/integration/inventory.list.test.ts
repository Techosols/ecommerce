/**
 * The stock list, as an operator uses it (docs/inventory.md).
 *
 * A stock figure is only useful next to the name of the thing it counts, and
 * only findable if the list can be searched by the thing an operator has in
 * their hand — a SKU on a box, a product name on a picking list. These are the
 * three additions that made the admin's inventory screen possible, so they are
 * tested at the boundary rather than assumed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { createSimpleProduct, uniqueHandle } from '../factories/catalogue.js'
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

describeIfDatabase('inventory list', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)

  const receive = (variantId: string, delta: number, extra: object = {}) =>
    post('/admin/inventory/adjustments', { variantId, delta, reason: 'receive', ...extra })

  async function product(title: string, sku: string) {
    return createSimpleProduct(app, owner.accessToken, {
      title,
      handle: uniqueHandle(sku.toLowerCase()),
      variants: [{ priceAmount: 1000, sku }],
    })
  }

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  describe('identity', () => {
    it('names what it is counting', async () => {
      const item = await product('Classic Burger', 'BURG-1')
      await receive(item.variants[0]!.id, 12)

      const res = await get('/admin/inventory')
      const row = res.body.data.find(
        (entry: { variantId: string }) => entry.variantId === item.variants[0]!.id,
      )

      // Without these three a stock row is a uuid and a number, which nobody
      // can act on.
      expect(row.productTitle).toBe('Classic Burger')
      expect(row.sku).toBe('BURG-1')
      expect(row.variantTitle).toBeTruthy()
      expect(row.productId).toBe(item.id)
      expect(row.totals.onHand).toBe(12)
    })

    it('names it on the item itself too, not only in the list', async () => {
      const item = await product('Classic Burger', 'BURG-1')
      const variantId = item.variants[0]!.id
      await receive(variantId, 12)

      // The item page has no list row to inherit a title from, and a page
      // headed with a uuid is a page nobody can use.
      const byVariant = await get(`/admin/inventory/variants/${variantId}`)
      expect(byVariant.body.data.productId).toBe(item.id)
      expect(byVariant.body.data.productTitle).toBe('Classic Burger')
      expect(byVariant.body.data.sku).toBe('BURG-1')
      expect(byVariant.body.data.variantTitle).toBeTruthy()

      const byId = await get(`/admin/inventory/items/${byVariant.body.data.id}`)
      expect(byId.body.data.productTitle).toBe('Classic Burger')
    })

    it('decides whether a row is low once, on the server', async () => {
      const item = await product('Nearly Out', 'LOW-1')
      await receive(item.variants[0]!.id, 1)

      const res = await get('/admin/inventory')
      const row = res.body.data.find(
        (entry: { variantId: string }) => entry.variantId === item.variants[0]!.id,
      )

      expect(row.isLow).toBe(true)
      expect(row.effectiveLowStockThreshold).toBeGreaterThan(0)
      // And the threshold travels with the page, so a screen never has to guess.
      expect(res.body.meta.defaultLowStockThreshold).toBe(row.effectiveLowStockThreshold)
    })
  })

  describe('search', () => {
    it('finds by SKU, by variant title and by product title alike', async () => {
      const burger = await product('Classic Burger', 'BURG-1')
      await product('Stone-Baked Pizza', 'PIZZA-1')

      const bySku = await get('/admin/inventory?q=BURG')
      expect(bySku.body.data).toHaveLength(1)
      expect(bySku.body.data[0].variantId).toBe(burger.variants[0]!.id)

      const byTitle = await get('/admin/inventory?q=classic')
      expect(byTitle.body.data).toHaveLength(1)
      expect(byTitle.body.data[0].productTitle).toBe('Classic Burger')

      // The count has to be narrowed too, or the pager offers pages that are
      // not there.
      expect(byTitle.body.meta.pagination.total).toBe(1)
    })

    it('matches case-insensitively, because a SKU on a box is not typed exactly', async () => {
      await product('Classic Burger', 'BURG-1')
      expect((await get('/admin/inventory?q=burg-1')).body.data).toHaveLength(1)
    })
  })

  describe('filters', () => {
    it('narrows to what is low', async () => {
      const low = await product('Nearly Out', 'LOW-1')
      const plenty = await product('Well Stocked', 'FULL-1')
      await receive(low.variants[0]!.id, 1)
      await receive(plenty.variants[0]!.id, 500)

      const res = await get('/admin/inventory?low=true')
      const ids = res.body.data.map((row: { variantId: string }) => row.variantId)
      expect(ids).toContain(low.variants[0]!.id)
      expect(ids).not.toContain(plenty.variants[0]!.id)
    })

    it('narrows to whether stock is counted at all', async () => {
      const tracked = await product('Counted', 'TRACK-1')
      const untracked = await product('Made To Order', 'FREE-1')

      const detail = await get(`/admin/inventory/variants/${untracked.variants[0]!.id}`)
      await request(app)
        .patch(`/api/v1/admin/inventory/items/${detail.body.data.id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ trackInventory: false })

      const res = await get('/admin/inventory?tracked=false')
      const ids = res.body.data.map((row: { variantId: string }) => row.variantId)
      expect(ids).toEqual([untracked.variants[0]!.id])
      expect(ids).not.toContain(tracked.variants[0]!.id)
    })

    it('narrows the totals to one location without hiding what is not there', async () => {
      const item = await product('Split Stock', 'SPLIT-1')
      const second = await post('/admin/locations', {
        code: uniqueHandle('shop'),
        name: 'Camden shop',
      })
      expect(second.status).toBe(201)

      const locations = await get('/admin/locations')
      const primary = locations.body.data.find((l: { isDefault: boolean }) => l.isDefault)
      await receive(item.variants[0]!.id, 20, { locationId: primary.id })

      const atSecond = await get(`/admin/inventory?locationId=${second.body.data.id}`)
      const row = atSecond.body.data.find(
        (entry: { variantId: string }) => entry.variantId === item.variants[0]!.id,
      )

      // Still listed, at zero: "not in the Camden shop" is the answer, and an
      // item that vanished from the list could not give it.
      expect(row).toBeDefined()
      expect(row.totals.onHand).toBe(0)

      const atPrimary = await get(`/admin/inventory?locationId=${primary.id}`)
      expect(
        atPrimary.body.data.find(
          (entry: { variantId: string }) => entry.variantId === item.variants[0]!.id,
        ).totals.onHand,
      ).toBe(20)
    })
  })

  describe('what is holding the stock', () => {
    it('names the orders reserving an item, not just a number', async () => {
      const item = await product('Reserved Stock', 'RES-1')
      await receive(item.variants[0]!.id, 10)

      const detail = await get(`/admin/inventory/variants/${item.variants[0]!.id}`)
      const itemId = detail.body.data.id as string

      const reservation = await post('/admin/inventory/reservations', {
        inventoryItemId: itemId,
        quantity: 3,
        ownerType: 'manual',
        ownerId: '00000000-0000-4000-8000-000000000001',
      })
      expect(reservation.status).toBe(201)

      const res = await get(`/admin/inventory/items/${itemId}/reservations`)
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].quantity).toBe(3)
      expect(res.body.data[0].owner).toMatchObject({ type: 'manual' })
    })

    it('lists only what is holding stock now, not what used to', async () => {
      const item = await product('Released Stock', 'REL-1')
      await receive(item.variants[0]!.id, 10)

      const detail = await get(`/admin/inventory/variants/${item.variants[0]!.id}`)
      const itemId = detail.body.data.id as string

      const reservation = await post('/admin/inventory/reservations', {
        inventoryItemId: itemId,
        quantity: 3,
        ownerType: 'manual',
        ownerId: '00000000-0000-4000-8000-000000000002',
      })
      await post(`/admin/inventory/reservations/${reservation.body.data.id}/release`)

      // A released reservation is history. The question is what is holding
      // stock *now*.
      expect((await get(`/admin/inventory/items/${itemId}/reservations`)).body.data).toEqual([])
    })
  })
})
