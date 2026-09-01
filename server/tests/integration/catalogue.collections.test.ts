/**
 * Collections — merchandising, manual and smart (§4).
 *
 * The things worth proving over and over: a smart collection is a question and
 * not a list, so it changes the moment a product does; the two kinds cannot be
 * confused with each other, at the service *and* in the database; and a rule
 * never reaches SQL as text however hostile the JSON.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { usersService } from '../../src/features/users/index.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { createSimpleProduct, publishProduct, uniqueHandle } from '../factories/catalogue.js'
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

describeIfDatabase('collections', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)
  const patch = (path: string, body: object = {}) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)
  const put = (path: string, body: object = {}) =>
    request(app).put(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)
  const del = (path: string, body: object = {}) =>
    request(app).delete(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)

  async function manual(overrides: Record<string, unknown> = {}) {
    const res = await post('/admin/collections', {
      title: 'Best sellers',
      handle: uniqueHandle('best-sellers'),
      ...overrides,
    })
    expect(res.status).toBe(201)
    return res.body.data as { id: string; type: string; rules: unknown }
  }

  async function smart(conditions: unknown[], overrides: Record<string, unknown> = {}) {
    const res = await post('/admin/collections', {
      title: 'Under £50',
      handle: uniqueHandle('under-50'),
      type: 'dynamic',
      rules: { match: 'all', conditions },
      ...overrides,
    })
    expect(res.status).toBe(201)
    return res.body.data as { id: string; summary?: string }
  }

  /** A product with a price, a vendor and a tag — enough for most rules. */
  async function product(overrides: Record<string, unknown> = {}) {
    return createSimpleProduct(app, owner.accessToken, {
      handle: uniqueHandle('p'),
      ...overrides,
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

  // ── Manual ────────────────────────────────────────────────────────────────

  describe('manual collections', () => {
    it('adds products without being told the ones already there', async () => {
      const collection = await manual()
      const first = await product()
      const second = await product()

      await put(`/admin/collections/${collection.id}/products`, { productIds: [first.id] })
      // The point of the POST: no need to resend `first`.
      const added = await post(`/admin/collections/${collection.id}/products`, {
        productIds: [second.id],
      })

      expect(added.status).toBe(200)
      expect(added.body.data.productIds).toEqual([first.id, second.id])
    })

    it('appends rather than reordering, because the order is the content', async () => {
      const collection = await manual()
      const a = await product()
      const b = await product()
      const c = await product()

      await put(`/admin/collections/${collection.id}/products`, { productIds: [b.id, a.id] })
      const added = await post(`/admin/collections/${collection.id}/products`, {
        productIds: [c.id],
      })

      expect(added.body.data.productIds).toEqual([b.id, a.id, c.id])
    })

    it('treats adding the same product twice as a no-op', async () => {
      const collection = await manual()
      const only = await product()

      await post(`/admin/collections/${collection.id}/products`, { productIds: [only.id] })
      const again = await post(`/admin/collections/${collection.id}/products`, {
        productIds: [only.id],
      })

      expect(again.status).toBe(200)
      expect(again.body.data.productIds).toEqual([only.id])
    })

    it('removes without disturbing what stays', async () => {
      const collection = await manual()
      const a = await product()
      const b = await product()
      await put(`/admin/collections/${collection.id}/products`, { productIds: [a.id, b.id] })

      const removed = await del(`/admin/collections/${collection.id}/products`, {
        productIds: [a.id],
      })
      expect(removed.body.data.productIds).toEqual([b.id])
    })

    it('carries no rules, and the database will not let it', async () => {
      const collection = await manual()
      expect(collection.rules).toEqual({ match: 'all', conditions: [] })

      await expect(
        execute(
          `UPDATE collections SET rules = '{"match":"all","conditions":[{"a":1}]}' WHERE id = $1`,
          [collection.id],
        ),
      ).rejects.toBeTruthy()
    })
  })

  // ── Smart ─────────────────────────────────────────────────────────────────

  describe('smart collections', () => {
    it('matches on price, taking the cheapest variant', async () => {
      // £45 in one size and £55 in another: buyable for under £50, so it
      // belongs in the sale. Taking the maximum would leave it out.
      const cheapEnough = await product({
        options: [{ name: 'Size', values: ['S', 'XL'] }],
        variants: [
          { priceAmount: 4500, options: { Size: 'S' } },
          { priceAmount: 5500, options: { Size: 'XL' } },
        ],
      })
      const tooDear = await product({ variants: [{ priceAmount: 9900 }] })

      const collection = await smart([{ field: 'price', operator: 'lt', value: 5000 }])
      const members = await get(`/admin/collections/${collection.id}`)

      expect(members.body.data.productIds).toContain(cheapEnough.id)
      expect(members.body.data.productIds).not.toContain(tooDear.id)
    })

    it('changes the moment the product does, with nothing to invalidate', async () => {
      const item = await product({ variants: [{ priceAmount: 9900 }] })
      const collection = await smart([{ field: 'price', operator: 'lt', value: 5000 }])

      expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([])

      await patch(`/admin/variants/${item.variants[0]!.id}`, { priceAmount: 4000 })

      // No membership was rebuilt: the rules were simply asked again.
      expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([
        item.id,
      ])
    })

    it('matches on tags and vendor', async () => {
      const match = await product({ tags: ['sale'], vendor: 'Acme' })
      await product({ tags: ['full-price'], vendor: 'Other' })

      const collection = await smart([
        { field: 'tags', operator: 'contains', value: 'sale' },
        { field: 'vendor', operator: 'equals', value: 'Acme' },
      ])
      expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([
        match.id,
      ])
    })

    it('combines with any as well as all', async () => {
      const tagged = await product({ tags: ['sale'] })
      const dear = await product({ variants: [{ priceAmount: 20_000 }] })

      const res = await post('/admin/collections/preview', {
        rules: {
          match: 'any',
          conditions: [
            { field: 'tags', operator: 'contains', value: 'sale' },
            { field: 'price', operator: 'gt', value: 15_000 },
          ],
        },
      })
      expect(res.body.data.productCount).toBe(2)
      expect(res.body.data.products.map((entry: { id: string }) => entry.id)).toEqual(
        expect.arrayContaining([tagged.id, dear.id]),
      )
    })

    it('says what it means in English, with money as money', async () => {
      const collection = await smart([{ field: 'price', operator: 'lt', value: 5000 }])
      // Not "less than 5000": a summary in minor units is a sentence nobody
      // can check against the rule they meant to write.
      expect(collection.summary).toMatch(/Price is less than .*50/)
      expect(collection.summary).not.toBe('Price is less than 5000')
    })

    it('previews without saving', async () => {
      await product({ tags: ['sale'] })

      const res = await post('/admin/collections/preview', {
        rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'sale' }] },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.productCount).toBe(1)
      // Named, so the preview answers "did I mean these?" and not just "how many".
      expect(res.body.data.products[0].title).toBeTruthy()
      expect((await get('/admin/collections')).body.data).toEqual([])
    })

    it('refuses hand-picked members, at the service and in the database', async () => {
      const collection = await smart([{ field: 'tags', operator: 'contains', value: 'sale' }])
      const item = await product()

      const refused = await post(`/admin/collections/${collection.id}/products`, {
        productIds: [item.id],
      })
      expect(refused.status).toBe(422)
      expect(refused.body.message).toMatch(/smart collection/)

      // And the trigger stands behind it, so no other write path can do it
      // either.
      await expect(
        execute(`INSERT INTO collection_products (collection_id, product_id) VALUES ($1,$2)`, [
          collection.id,
          item.id,
        ]),
      ).rejects.toBeTruthy()
    })

    it('drops hand-picked members when a manual collection becomes smart', async () => {
      const collection = await manual()
      const item = await product({ tags: ['sale'] })
      await put(`/admin/collections/${collection.id}/products`, { productIds: [item.id] })

      await patch(`/admin/collections/${collection.id}`, {
        type: 'dynamic',
        rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'nope' }] },
      })

      // The rules are the membership now, and they match nothing — the leftover
      // row would have been a product nobody could explain.
      const row = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM collection_products WHERE collection_id = $1`,
        [collection.id],
      )
      expect(row?.count).toBe(0)
      expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([])
    })

    it('clears the rules when a smart collection becomes manual', async () => {
      const collection = await smart([{ field: 'tags', operator: 'contains', value: 'sale' }])

      const res = await patch(`/admin/collections/${collection.id}`, { type: 'manual' })
      expect(res.body.data.rules).toEqual({ match: 'all', conditions: [] })
    })

    it('refuses a field that is not in the catalogue', async () => {
      const res = await post('/admin/collections/preview', {
        rules: { match: 'all', conditions: [{ field: 'search_vector', operator: 'is_set' }] },
      })
      expect(res.status).toBe(422)
    })

    it('refuses an operator the field type does not have', async () => {
      const res = await post('/admin/collections/preview', {
        rules: { match: 'all', conditions: [{ field: 'price', operator: 'contains', value: 'x' }] },
      })
      expect(res.status).toBe(422)
    })

    it('binds values instead of interpolating them', async () => {
      const item = await product()

      const res = await post('/admin/collections/preview', {
        rules: {
          match: 'all',
          conditions: [
            { field: 'title', operator: 'equals', value: `x'; DROP TABLE products; --` },
          ],
        },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.productCount).toBe(0)

      expect((await get(`/admin/products/${item.id}`)).status).toBe(200)
    })

    it('refuses rules that cannot be compiled, before they are stored', async () => {
      const res = await post('/admin/collections', {
        title: 'Broken',
        handle: uniqueHandle('broken'),
        type: 'dynamic',
        rules: { match: 'all', conditions: [{ field: 'nope', operator: 'equals', value: 1 }] },
      })
      expect(res.status).toBe(422)
      expect((await get('/admin/collections')).body.data).toEqual([])
    })

    it('publishes the field catalogue without leaking the SQL behind it', async () => {
      const res = await get('/admin/collections/rules/fields')
      expect(res.status).toBe(200)

      const price = res.body.data.find((field: { key: string }) => field.key === 'price')
      expect(price.operators).toContain('lt')
      expect(JSON.stringify(res.body.data)).not.toContain('price_amount')
    })
  })

  // ── A product's collections ───────────────────────────────────────────────

  describe('a product’s collections', () => {
    it('reports both kinds, and says which came from a rule', async () => {
      const item = await product({ tags: ['sale'] })
      const byHand = await manual()
      await put(`/admin/collections/${byHand.id}/products`, { productIds: [item.id] })
      const byRule = await smart([{ field: 'tags', operator: 'contains', value: 'sale' }])

      const res = await get(`/admin/products/${item.id}/collections`)
      const found = res.body.data as Array<{ id: string; matchedByRules: boolean }>

      expect(found.find((entry) => entry.id === byHand.id)?.matchedByRules).toBe(false)
      expect(found.find((entry) => entry.id === byRule.id)?.matchedByRules).toBe(true)
    })
  })

  // ── Bulk ──────────────────────────────────────────────────────────────────

  describe('bulk product actions', () => {
    it('reports per product rather than failing the batch', async () => {
      const draft = await product()
      const active = await product()
      await publishProduct(app, owner.accessToken, active.id)

      // `draft` is still a draft, and publishing one is refused — the other
      // must still go through, and the caller must be able to see which failed.
      const res = await post('/admin/products/bulk', {
        productIds: [draft.id, active.id],
        action: 'publish',
      })

      expect(res.status).toBe(200)
      expect(res.body.data.succeeded).toBe(1)
      expect(res.body.data.failed).toBe(1)
      const failure = res.body.data.results.find((entry: { ok: boolean }) => !entry.ok)
      expect(failure.productId).toBe(draft.id)
      expect(failure.error).toMatch(/activate/i)
    })

    it('adds tags without duplicating what is already there', async () => {
      const item = await product({ tags: ['sale'] })

      await post('/admin/products/bulk', {
        productIds: [item.id],
        action: 'addTags',
        tags: ['SALE', 'clearance'],
      })

      const res = await get(`/admin/products/${item.id}`)
      expect(res.body.data.tags).toEqual(['sale', 'clearance'])
    })

    it('removes tags case-insensitively', async () => {
      const item = await product({ tags: ['Sale', 'keep'] })

      await post('/admin/products/bulk', {
        productIds: [item.id],
        action: 'removeTags',
        tags: ['sale'],
      })

      expect((await get(`/admin/products/${item.id}`)).body.data.tags).toEqual(['keep'])
    })

    it('adds a selection to a collection', async () => {
      const collection = await manual()
      const a = await product()
      const b = await product()

      const res = await post('/admin/products/bulk', {
        productIds: [a.id, b.id],
        action: 'addToCollection',
        collectionId: collection.id,
      })
      expect(res.body.data.succeeded).toBe(2)
      expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([
        a.id,
        b.id,
      ])
    })

    it('refuses an action whose arguments are missing', async () => {
      const item = await product()
      const res = await post('/admin/products/bulk', {
        productIds: [item.id],
        action: 'setStatus',
      })
      expect(res.status).toBe(422)
    })

    it('changes status across the selection', async () => {
      const a = await product()
      const b = await product()

      await post('/admin/products/bulk', {
        productIds: [a.id, b.id],
        action: 'setStatus',
        status: 'active',
      })

      expect((await get(`/admin/products/${a.id}`)).body.data.status).toBe('active')
      expect((await get(`/admin/products/${b.id}`)).body.data.status).toBe('active')
    })
  })
})
