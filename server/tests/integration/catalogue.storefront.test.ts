/**
 * The storefront catalogue (§7.1, docs/catalogue-model.md).
 *
 * Two properties matter here more than any feature:
 *
 *   **Nothing unpublished is visible, in any way.** Not the product, not its
 *   price, not the fact that its handle exists.
 *
 *   **The public serializer is a whitelist.** It is written separately from the
 *   admin one, so a new admin-only field is invisible by default rather than by
 *   somebody remembering to delete it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { execute } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  createCategory,
  createCollection,
  createPizza,
  createSimpleProduct,
  publishProduct,
  stockProduct,
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

const shop = (path: string) => request(app).get(`/api/v1/storefront${path}`)

describeIfDatabase('catalogue — storefront', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

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

  // ── Visibility ────────────────────────────────────────────────────────────

  it('shows a published product to anyone, with no token', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop(`/products/${product.handle}`)
    expect(res.status).toBe(200)
    expect(res.body.data.title).toBe('Classic Burger')
    expect(res.body.data.variants[0].price).toEqual({ amount: 599, currency: 'USD' })
  })

  it('hides a draft product entirely, as though the handle never existed', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)

    const detail = await shop(`/products/${product.handle}`)
    expect(detail.status).toBe(404)
    // A 403 would confirm the handle is real, which is a small catalogue leak.
    expect(detail.body.code).toBe('NOT_FOUND')

    const list = await shop('/products')
    expect(list.body.data).toHaveLength(0)
  })

  it('hides an active product that is not published', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await request(app)
      .post(`/api/v1/admin/products/${product.id}/activate`)
      .set('Authorization', bearer(admin.accessToken))

    expect((await shop(`/products/${product.handle}`)).status).toBe(404)
  })

  it('hides a product the moment it is unpublished', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)
    expect((await shop(`/products/${product.handle}`)).status).toBe(200)

    await request(app)
      .post(`/api/v1/admin/products/${product.id}/unpublish`)
      .set('Authorization', bearer(admin.accessToken))
      .send({})

    // Cache invalidation is part of the security property, not a nicety.
    expect((await shop(`/products/${product.handle}`)).status).toBe(404)
  })

  it('hides a product as soon as it is archived', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)
    await request(app)
      .post(`/api/v1/admin/products/${product.id}/archive`)
      .set('Authorization', bearer(admin.accessToken))

    expect((await shop(`/products/${product.handle}`)).status).toBe(404)
  })

  // ── The public shape ──────────────────────────────────────────────────────

  it('exposes no admin-only field', async () => {
    const product = await createSimpleProduct(app, admin.accessToken, {
      vendor: 'Kitchen',
      metadata: { costPrice: 210, supplier: 'Acme' },
    })
    await publishProduct(app, admin.accessToken, product.id)

    const res = await shop(`/products/${product.handle}`)
    const body = JSON.stringify(res.body)

    for (const leaked of ['metadata', 'costPrice', 'Acme', 'vendor', 'createdBy', 'status']) {
      expect(body, `${leaked} must not be public`).not.toContain(leaked)
    }
    expect(res.body.data.publications).toBeUndefined()
  })

  it('omits inactive variants rather than marking them, so nothing can quote one', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, pizza.id)

    await request(app)
      .patch(`/api/v1/admin/variants/${pizza.variants[0]!.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ isActive: false })

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.variants).toHaveLength(5)
    expect(
      res.body.data.variants.some((v: { id: string }) => v.id === pizza.variants[0]!.id),
    ).toBe(false)
  })

  it('computes a price range from the sellable variants only', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await stockProduct(app, admin.accessToken, pizza)
    await publishProduct(app, admin.accessToken, pizza.id)

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.priceRange).toEqual({
      min: { amount: 799, currency: 'USD' },
      max: { amount: 1449, currency: 'USD' },
    })
  })

  it('gives the picker everything it needs to choose a variant', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, pizza.id)

    const res = await shop(`/products/${pizza.handle}`)
    expect(res.body.data.options.map((o: { name: string }) => o.name)).toEqual(['Size', 'Crust'])

    const variant = res.body.data.variants[0]
    expect(variant.options).toEqual([
      { name: 'Size', value: 'Small', valueId: expect.any(String) },
      { name: 'Crust', value: 'Classic', valueId: expect.any(String) },
    ])
  })

  // ── Handles ───────────────────────────────────────────────────────────────

  it('keeps an old handle working and names the canonical one', async () => {
    const product = await createSimpleProduct(app, admin.accessToken, {
      handle: 'classic-burger-v1',
    })
    await publishProduct(app, admin.accessToken, product.id)

    await request(app)
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ handle: 'classic-burger-v2' })

    const old = await shop('/products/classic-burger-v1')
    expect(old.status).toBe(200)
    expect(old.body.meta.canonicalHandle).toBe('classic-burger-v2')
    expect(old.body.meta.redirectedFrom).toBe('classic-burger-v1')

    const current = await shop('/products/classic-burger-v2')
    expect(current.status).toBe(200)
    expect(current.body.meta.redirectedFrom).toBeUndefined()
  })

  it('will not let a new product claim a handle another product retired', async () => {
    const first = await createSimpleProduct(app, admin.accessToken, { handle: 'the-handle' })
    await request(app)
      .patch(`/api/v1/admin/products/${first.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ handle: 'the-handle-renamed' })

    // Uniqueness across *time*: otherwise an old bookmark would silently land
    // on a different product.
    const second = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', bearer(admin.accessToken))
      .send({ title: 'Impostor', handle: 'the-handle', variants: [{ priceAmount: 100 }] })

    expect(second.status).toBe(409)
    expect(second.body.code).toBe('HANDLE_TAKEN')
  })

  // ── Listing, filtering, browsing ──────────────────────────────────────────

  it('lists only published products, as cards', async () => {
    const published = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('a') })
    await stockProduct(app, admin.accessToken, published)
    await publishProduct(app, admin.accessToken, published.id)
    await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })

    const res = await shop('/products')
    expect(res.status).toBe(200)
    expect(res.body.meta.pagination.total).toBe(1)

    const card = res.body.data[0]
    expect(card).toMatchObject({ handle: published.handle, available: true })
    // A card carries what a card needs, not a whole product.
    expect(card.variants).toBeUndefined()
    expect(card.description).toBeUndefined()
  })

  it('filters by category handle, not by uuid', async () => {
    const category = await createCategory(app, admin.accessToken, { handle: 'burgers' })
    const inCategory = await createSimpleProduct(app, admin.accessToken, {
      handle: uniqueHandle('in'),
      categoryId: category.id,
    })
    const outside = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('out') })
    await publishProduct(app, admin.accessToken, inCategory.id)
    await publishProduct(app, admin.accessToken, outside.id)

    const res = await shop('/products?category=burgers')
    expect(res.body.meta.pagination.total).toBe(1)
    expect(res.body.data[0].handle).toBe(inCategory.handle)
  })

  it('filters by collection and honours the merchandiser’s order', async () => {
    const first = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('one') })
    const second = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('two') })
    await publishProduct(app, admin.accessToken, first.id)
    await publishProduct(app, admin.accessToken, second.id)

    const collection = await createCollection(app, admin.accessToken, { handle: 'best-sellers' })
    await request(app)
      .put(`/api/v1/admin/collections/${collection.id}/products`)
      .set('Authorization', bearer(admin.accessToken))
      // Deliberately not creation order: the arrangement is the content.
      .send({ productIds: [second.id, first.id] })

    const res = await shop('/products?collection=best-sellers')
    expect(res.body.data.map((card: { handle: string }) => card.handle)).toEqual([
      second.handle,
      first.handle,
    ])
  })

  /**
   * A dynamic collection has no rows in `collection_products` — its membership
   * is its rules, evaluated at read time. The storefront listing has to
   * evaluate them, not join a table that is empty for it by definition.
   */
  it('filters by a dynamic collection using its rules', async () => {
    const stocked = await createSimpleProduct(app, admin.accessToken, {
      handle: uniqueHandle('sells-well'),
      tags: ['bestseller'],
    })
    const other = await createSimpleProduct(app, admin.accessToken, {
      handle: uniqueHandle('sells-badly'),
    })
    await publishProduct(app, admin.accessToken, stocked.id)
    await publishProduct(app, admin.accessToken, other.id)

    await createCollection(app, admin.accessToken, {
      handle: 'bestsellers',
      type: 'dynamic',
      rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'bestseller' }] },
    })

    const res = await shop('/products?collection=bestsellers')
    expect(res.status).toBe(200)
    expect(res.body.meta.pagination.total).toBe(1)
    expect(res.body.data[0].handle).toBe(stocked.handle)
  })

  it('still hides an unpublished product that a dynamic collection’s rules match', async () => {
    const hidden = await createSimpleProduct(app, admin.accessToken, {
      handle: uniqueHandle('secret'),
      tags: ['bestseller'],
    })
    expect(hidden.id).toBeTruthy() // created, but never published

    await createCollection(app, admin.accessToken, {
      handle: 'bestsellers-2',
      type: 'dynamic',
      rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'bestseller' }] },
    })

    const res = await shop('/products?collection=bestsellers-2')
    expect(res.body.data).toEqual([])
  })

  // ── Sorting and filtering ─────────────────────────────────────────────────

  /** Three published products at three prices, one of them sold out. */
  async function priced() {
    const cheap = await createSimpleProduct(app, admin.accessToken, {
      title: 'Anchovy',
      handle: uniqueHandle('cheap'),
      variants: [{ priceAmount: 300 }],
    })
    const middle = await createSimpleProduct(app, admin.accessToken, {
      title: 'Beetroot',
      handle: uniqueHandle('middle'),
      variants: [{ priceAmount: 900 }],
    })
    const dear = await createSimpleProduct(app, admin.accessToken, {
      title: 'Cardamom',
      handle: uniqueHandle('dear'),
      variants: [{ priceAmount: 2500 }],
    })
    for (const product of [cheap, middle, dear]) {
      await publishProduct(app, admin.accessToken, product.id)
    }
    // Only two are stocked. The third is tracked at zero, i.e. genuinely out.
    await stockProduct(app, admin.accessToken, cheap)
    await stockProduct(app, admin.accessToken, dear)
    return { cheap, middle, dear }
  }

  const handles = (res: { body: { data: { handle: string }[] } }) =>
    res.body.data.map((card) => card.handle)

  it('sorts by price, cheapest first', async () => {
    const { cheap, middle, dear } = await priced()

    const res = await shop('/products?sort=price_low')

    expect(handles(res)).toEqual([cheap.handle, middle.handle, dear.handle])
  })

  it('sorts by price, dearest first', async () => {
    const { cheap, middle, dear } = await priced()

    const res = await shop('/products?sort=price_high')

    expect(handles(res)).toEqual([dear.handle, middle.handle, cheap.handle])
  })

  it('sorts by title', async () => {
    const { cheap, middle, dear } = await priced()

    const res = await shop('/products?sort=title')

    expect(handles(res)).toEqual([cheap.handle, middle.handle, dear.handle])
  })

  it('filters by a price range, against the price it actually prints', async () => {
    const { middle } = await priced()

    const res = await shop('/products?minPrice=500&maxPrice=1000')

    expect(res.body.meta.pagination.total).toBe(1)
    expect(handles(res)).toEqual([middle.handle])
  })

  it('shows only what can be bought when asked', async () => {
    const { cheap, dear, middle } = await priced()

    const res = await shop('/products?inStock=true')

    // The unstocked one is a tracked variant at zero — genuinely unavailable,
    // not merely uncounted.
    expect(handles(res).sort()).toEqual([cheap.handle, dear.handle].sort())
    expect(handles(res)).not.toContain(middle.handle)
  })

  it('counts the same page it returns when filtering', async () => {
    // The bug this defends: filtering after the page has been cut returns
    // fewer rows than the total claims, and the pager offers a page 2 that
    // does not exist.
    await priced()

    const res = await shop('/products?inStock=true')

    expect(res.body.meta.pagination.total).toBe(res.body.data.length)
  })

  it('lets a shopper override a collection’s hand-placed order', async () => {
    const { cheap, middle, dear } = await priced()
    const collection = await createCollection(app, admin.accessToken, { handle: 'picks' })
    await request(app)
      .put(`/api/v1/admin/collections/${collection.id}/products`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ productIds: [dear.id, cheap.id, middle.id] })

    // Merchandiser's order by default…
    expect(handles(await shop('/products?collection=picks'))).toEqual([
      dear.handle,
      cheap.handle,
      middle.handle,
    ])
    // …and the shopper's when they ask for one.
    expect(handles(await shop('/products?collection=picks&sort=price_low'))).toEqual([
      cheap.handle,
      middle.handle,
      dear.handle,
    ])
  })

  it('refuses a sort key the storefront does not publish', async () => {
    // `status` is an admin sort. Accepting it would let a listing be ordered by
    // a field the storefront never shows.
    expect((await shop('/products?sort=status')).status).toBe(422)
  })

  it('answers an unknown category or collection with an empty page, not an error', async () => {
    expect((await shop('/products?category=nope')).status).toBe(200)
    expect((await shop('/products?collection=nope')).body.data).toEqual([])
  })

  it('searches titles', async () => {
    const burger = await createSimpleProduct(app, admin.accessToken, { handle: uniqueHandle('b') })
    const pizza = await createPizza(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, burger.id)
    await publishProduct(app, admin.accessToken, pizza.id)

    const res = await shop('/products?q=pizza')
    expect(res.body.meta.pagination.total).toBe(1)
    expect(res.body.data[0].handle).toBe(pizza.handle)
  })

  it('does not fall over on search input that would break to_tsquery', async () => {
    const res = await shop('/products?q=%22unbalanced%20%26%20quote')
    expect(res.status).toBe(200)
  })

  // ── Categories and collections ────────────────────────────────────────────

  it('serves the category tree', async () => {
    const parent = await createCategory(app, admin.accessToken, { name: 'Food', handle: 'food' })
    await createCategory(app, admin.accessToken, {
      name: 'Burgers',
      handle: 'burgers',
      parentId: parent.id,
    })

    const res = await shop('/categories')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].handle).toBe('food')
    expect(res.body.data[0].children[0].handle).toBe('burgers')
  })

  it('gives a category its breadcrumb', async () => {
    const parent = await createCategory(app, admin.accessToken, { name: 'Food', handle: 'food' })
    const child = await createCategory(app, admin.accessToken, {
      name: 'Burgers',
      handle: 'burgers',
      parentId: parent.id,
    })

    const res = await shop(`/categories/${child.handle}`)
    expect(res.body.data.breadcrumb.map((entry: { handle: string }) => entry.handle)).toEqual([
      'food',
      'burgers',
    ])
  })

  it('hides an inactive category and collection', async () => {
    const category = await createCategory(app, admin.accessToken, { handle: 'hidden-cat' })
    const collection = await createCollection(app, admin.accessToken, { handle: 'hidden-col' })

    await execute('UPDATE categories SET is_active = false WHERE id = $1', [category.id])
    await execute('UPDATE collections SET is_active = false WHERE id = $1', [collection.id])

    expect((await shop('/categories/hidden-cat')).status).toBe(404)
    expect((await shop('/collections/hidden-col')).status).toBe(404)
  })

  it('lists collections', async () => {
    await createCollection(app, admin.accessToken, { title: 'New', handle: 'new' })
    const res = await shop('/collections')
    expect(res.body.data.map((c: { handle: string }) => c.handle)).toContain('new')
  })
})
