/**
 * Categories, collections and product media (docs/catalogue-model.md §4, §9).
 *
 * The distinction under test: a **category** answers *what kind of product is
 * this* — a tree, one node per product, structural. A **collection** answers
 * *which products belong together* — flat, many-to-many, and its order is
 * editorial content someone arranged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { execute, query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  createCategory,
  createCollection,
  createSimpleProduct,
  uniqueHandle,
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
const storage = new MemoryStorageProvider('media-test')

/** A `ready` media asset, standing in for one the worker has processed. */
async function readyAsset(): Promise<string> {
  const id = crypto.randomUUID()
  await execute(
    `INSERT INTO media_assets (id, storage_key, bucket, declared_mime, status, mime_type,
                               byte_size, width, height)
     VALUES ($1, $2, 'media-test', 'image/png', 'ready', 'image/png', 100, 10, 10)`,
    [id, `media/2026/08/${id}/original.png`],
  )
  return id
}

async function pendingAsset(): Promise<string> {
  const id = crypto.randomUUID()
  await execute(
    `INSERT INTO media_assets (id, storage_key, bucket, declared_mime, status)
     VALUES ($1, $2, 'media-test', 'image/png', 'pending')`,
    [id, `media/2026/08/${id}/original.png`],
  )
  return id
}

describeIfDatabase('catalogue — categories, collections and media', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken)).send(body)
  const patch = (path: string, body: object = {}) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken)).send(body)
  const put = (path: string, body: object = {}) =>
    request(app).put(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken)).send(body)
  const del = (path: string) =>
    request(app).delete(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken))
  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(admin.accessToken))

  beforeAll(setupDatabase)
  beforeEach(async () => {
    setStorage(storage)
    storage.clear()
    admin = await createUserAndLogin(app, { roles: ['admin'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(async () => {
    setStorage(undefined)
    await teardownDatabase()
  })

  // ── Categories: a tree ────────────────────────────────────────────────────

  it('nests categories', async () => {
    const parent = await createCategory(app, admin.accessToken, { name: 'Food', handle: 'food' })
    const child = await createCategory(app, admin.accessToken, {
      name: 'Burgers',
      handle: 'burgers',
      parentId: parent.id,
    })

    const res = await get(`/admin/categories`)
    const found = res.body.data.find((c: { id: string }) => c.id === child.id)
    expect(found.parentId).toBe(parent.id)
  })

  it('derives a handle from the name when none is given', async () => {
    const res = await post('/admin/categories', { name: 'Loaded Fries & Sides' })
    expect(res.status).toBe(201)
    expect(res.body.data.handle).toBe('loaded-fries-sides')
  })

  it('refuses a category that is its own parent', async () => {
    const category = await createCategory(app, admin.accessToken)
    const res = await patch(`/admin/categories/${category.id}`, { parentId: category.id })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CATEGORY_CYCLE')
  })

  it('refuses a move that would put a category inside its own subtree', async () => {
    const grandparent = await createCategory(app, admin.accessToken, { handle: uniqueHandle('gp') })
    const parent = await createCategory(app, admin.accessToken, {
      handle: uniqueHandle('p'),
      parentId: grandparent.id,
    })
    const child = await createCategory(app, admin.accessToken, {
      handle: uniqueHandle('c'),
      parentId: parent.id,
    })

    // A cycle would make every recursive read of the tree a bounded lie.
    const res = await patch(`/admin/categories/${grandparent.id}`, { parentId: child.id })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CATEGORY_CYCLE')
  })

  it('bounds how deep a tree may go', async () => {
    let parentId: string | null = null
    // MAX_DEPTH is 5, so five levels are allowed and the sixth is refused.
    for (let depth = 0; depth < 6; depth += 1) {
      const res: request.Response = await post('/admin/categories', {
        name: `Level ${depth}`,
        handle: uniqueHandle(`level-${depth}`),
        ...(parentId ? { parentId } : {}),
      })
      if (depth < 5) {
        expect(res.status, `depth ${depth} should be allowed`).toBe(201)
        parentId = res.body.data.id as string
      } else {
        expect(res.status).toBe(422)
      }
    }
  })

  it('refuses to archive a category that still holds products', async () => {
    const category = await createCategory(app, admin.accessToken)
    await createSimpleProduct(app, admin.accessToken, { categoryId: category.id })

    const res = await del(`/admin/categories/${category.id}`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CATEGORY_IN_USE')
  })

  it('refuses to archive a category that still has children', async () => {
    const parent = await createCategory(app, admin.accessToken, { handle: uniqueHandle('p') })
    await createCategory(app, admin.accessToken, {
      handle: uniqueHandle('c'),
      parentId: parent.id,
    })

    const res = await del(`/admin/categories/${parent.id}`)
    expect(res.status).toBe(409)
  })

  it('archives an empty category', async () => {
    const category = await createCategory(app, admin.accessToken)
    expect((await del(`/admin/categories/${category.id}`)).status).toBe(204)

    const row = await queryOne<{ archived_at: Date | null }>(
      'SELECT archived_at FROM categories WHERE id = $1',
      [category.id],
    )
    expect(row?.archived_at).not.toBeNull()
  })

  it('refuses a duplicate category handle', async () => {
    await createCategory(app, admin.accessToken, { handle: 'burgers' })
    const res = await post('/admin/categories', { name: 'Also burgers', handle: 'burgers' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('HANDLE_TAKEN')
  })

  // ── Collections: a set with an order ──────────────────────────────────────

  it('holds a product in many collections but one category', async () => {
    const category = await createCategory(app, admin.accessToken)
    const product = await createSimpleProduct(app, admin.accessToken, { categoryId: category.id })

    const bestSellers = await createCollection(app, admin.accessToken, { handle: uniqueHandle('bs') })
    const familyDeals = await createCollection(app, admin.accessToken, { handle: uniqueHandle('fd') })
    await put(`/admin/collections/${bestSellers.id}/products`, { productIds: [product.id] })
    await put(`/admin/collections/${familyDeals.id}/products`, { productIds: [product.id] })

    const res = await get(`/admin/products/${product.id}`)
    expect(res.body.data.collectionIds).toHaveLength(2)
    expect(res.body.data.category.id).toBe(category.id)
  })

  it('stores the order a merchandiser chose', async () => {
    const a = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('a') })
    const b = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })
    const c = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('c') })
    const collection = await createCollection(app, admin.accessToken)

    await put(`/admin/collections/${collection.id}/products`, {
      productIds: [c.id, a.id, b.id],
    })

    const rows = await query<{ product_id: string; position: number }>(
      'SELECT product_id, position FROM collection_products WHERE collection_id = $1 ORDER BY position',
      [collection.id],
    )
    expect(rows.map((row) => row.product_id)).toEqual([c.id, a.id, b.id])
    expect(rows.map((row) => row.position)).toEqual([0, 1, 2])
  })

  it('replaces membership wholesale, so the list is always what was sent', async () => {
    const a = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('a') })
    const b = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })
    const collection = await createCollection(app, admin.accessToken)

    await put(`/admin/collections/${collection.id}/products`, { productIds: [a.id, b.id] })
    await put(`/admin/collections/${collection.id}/products`, { productIds: [b.id] })

    const res = await get(`/admin/collections/${collection.id}`)
    expect(res.body.data.productIds).toEqual([b.id])
  })

  it('empties a collection when sent an empty list', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const collection = await createCollection(app, admin.accessToken)
    await put(`/admin/collections/${collection.id}/products`, { productIds: [product.id] })

    await put(`/admin/collections/${collection.id}/products`, { productIds: [] })
    expect((await get(`/admin/collections/${collection.id}`)).body.data.productIds).toEqual([])
  })

  it('rejects a duplicate or unknown product in the list', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const collection = await createCollection(app, admin.accessToken)

    const duplicated = await put(`/admin/collections/${collection.id}/products`, {
      productIds: [product.id, product.id],
    })
    expect(duplicated.status).toBe(422)

    const unknown = await put(`/admin/collections/${collection.id}/products`, {
      productIds: ['00000000-0000-4000-8000-000000000000'],
    })
    expect(unknown.status).toBe(422)
  })

  it('keeps membership when a collection is archived, so restoring restores the list', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const collection = await createCollection(app, admin.accessToken)
    await put(`/admin/collections/${collection.id}/products`, { productIds: [product.id] })

    await del(`/admin/collections/${collection.id}`)

    const rows = await query('SELECT 1 FROM collection_products WHERE collection_id = $1', [
      collection.id,
    ])
    expect(rows).toHaveLength(1)
  })

  it('reserves a type column so dynamic collections need no redesign', async () => {
    const collection = await createCollection(app, admin.accessToken)
    const res = await get(`/admin/collections/${collection.id}`)
    expect(res.body.data.type).toBe('manual')
  })

  // ── Product media ─────────────────────────────────────────────────────────

  it('attaches a ready image and makes the first one primary', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const mediaId = await readyAsset()

    const res = await post(`/admin/products/${product.id}/media`, { mediaId, alt: 'A burger' })
    expect(res.status).toBe(201)
    expect(res.body.data.media).toHaveLength(1)
    expect(res.body.data.media[0]).toMatchObject({ isPrimary: true, alt: 'A burger' })
    // The URL comes from the StorageProvider, not from anything stored.
    expect(res.body.data.media[0].url).toContain('memory://')
  })

  it('refuses an image that has not been processed', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const mediaId = await pendingAsset()

    const res = await post(`/admin/products/${product.id}/media`, { mediaId })
    expect(res.status).toBe(422)
  })

  it('stores a media reference, never a URL', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const mediaId = await readyAsset()
    await post(`/admin/products/${product.id}/media`, { mediaId })

    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'product_media'`,
    )
    const names = columns.map((c) => c.column_name)
    expect(names).toContain('media_id')
    expect(names).not.toContain('url')
    expect(names).not.toContain('storage_key')
  })

  it('keeps exactly one primary image', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const first = await readyAsset()
    const second = await readyAsset()

    await post(`/admin/products/${product.id}/media`, { mediaId: first })
    const res = await post(`/admin/products/${product.id}/media`, {
      mediaId: second,
      isPrimary: true,
    })

    const primaries = res.body.data.media.filter((m: { isPrimary: boolean }) => m.isPrimary)
    expect(primaries).toHaveLength(1)
    expect(primaries[0].mediaId).toBe(second)
  })

  it('reorders images and can name a new primary', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const a = await post(`/admin/products/${product.id}/media`, { mediaId: await readyAsset() })
    const b = await post(`/admin/products/${product.id}/media`, { mediaId: await readyAsset() })

    const ids = [b.body.data.media[1].id, a.body.data.media[0].id]
    const res = await put(`/admin/products/${product.id}/media/order`, {
      order: ids,
      primaryId: ids[0],
    })

    expect(res.status).toBe(200)
    expect(res.body.data.media[0].id).toBe(ids[0])
    expect(res.body.data.media[0].isPrimary).toBe(true)
  })

  it('refuses to reorder using an image from another product', async () => {
    const product = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('a') })
    const other = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })
    await post(`/admin/products/${product.id}/media`, { mediaId: await readyAsset() })
    const foreign = await post(`/admin/products/${other.id}/media`, { mediaId: await readyAsset() })

    const res = await put(`/admin/products/${product.id}/media/order`, {
      order: [foreign.body.data.media[0].id],
    })
    expect(res.status).toBe(422)
  })

  it('detaches an image without destroying the asset', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const mediaId = await readyAsset()
    const attached = await post(`/admin/products/${product.id}/media`, { mediaId })
    const productMediaId = attached.body.data.media[0].id

    expect((await del(`/admin/products/${product.id}/media/${productMediaId}`)).status).toBe(204)

    // The media asset belongs to the media feature; it may be used elsewhere.
    const asset = await queryOne('SELECT 1 FROM media_assets WHERE id = $1', [mediaId])
    expect(asset).toBeTruthy()
  })

  it('refuses to point a variant at an image belonging to another product', async () => {
    const product = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('a') })
    const other = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })
    const foreign = await post(`/admin/products/${other.id}/media`, { mediaId: await readyAsset() })

    const res = await patch(`/admin/variants/${product.variants[0]!.id}`, {
      mediaId: foreign.body.data.media[0].id,
    })
    expect(res.status).toBe(422)
  })

  it('clears a variant’s image without harming the variant when the image goes', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const attached = await post(`/admin/products/${product.id}/media`, { mediaId: await readyAsset() })
    const productMediaId = attached.body.data.media[0].id
    const variantId = product.variants[0]!.id

    await patch(`/admin/variants/${variantId}`, { mediaId: productMediaId })
    await del(`/admin/products/${product.id}/media/${productMediaId}`)

    // The composite FK names media_id on SET NULL; without that column list it
    // would try to null product_id too and fail the delete.
    const row = await queryOne<{ media_id: string | null; product_id: string }>(
      'SELECT media_id, product_id FROM product_variants WHERE id = $1',
      [variantId],
    )
    expect(row?.media_id).toBeNull()
    expect(row?.product_id).toBe(product.id)
  })
})
