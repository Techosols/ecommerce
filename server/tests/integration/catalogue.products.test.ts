/**
 * Products, options and variants (§23.3, docs/catalogue-model.md).
 *
 * The commerce model is the thing under test, not CRUD. The questions asked
 * here are the ones that decide whether this schema survives contact with
 * carts and orders:
 *
 *   • is a variant the only purchasable unit, and does it carry the price?
 *   • can a product vary on more than one axis without a schema change?
 *   • are lifecycle, publication and availability genuinely separate?
 *   • is anything ever destroyed that an order will later need?
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin, eventNames } from '../factories/auth.js'
import {
  createCategory,
  createPizza,
  createSimpleProduct,
  publishProduct,
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

function post(token: string, path: string, body: object = {}) {
  return request(app).post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body)
}
function patch(token: string, path: string, body: object = {}) {
  return request(app).patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body)
}
function get(token: string, path: string) {
  return request(app).get(`/api/v1${path}`).set('Authorization', bearer(token))
}
function del(token: string, path: string) {
  return request(app).delete(`/api/v1${path}`).set('Authorization', bearer(token))
}

interface OptionShape {
  id: string
  name: string
  values: Array<{ id: string; value: string }>
}

/** The option by name, asserted present — a missing one is a test bug, not a case. */
function optionNamed(options: unknown, name: string): OptionShape {
  const found = (options as OptionShape[]).find((option) => option.name === name)
  if (!found) throw new Error(`No option named ${name}`)
  return found
}

function valueNamed(option: OptionShape, value: string): { id: string; value: string } {
  const found = option.values.find((entry) => entry.value === value)
  if (!found) throw new Error(`No value ${value} on ${option.name}`)
  return found
}

describeIfDatabase('catalogue — products and variants', () => {
  let admin: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    admin = await createUserAndLogin(app, { roles: ['admin'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Product / variant separation ──────────────────────────────────────────

  it('gives a product with no options exactly one Default variant', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)

    expect(product.options).toHaveLength(0)
    expect(product.variants).toHaveLength(1)
    expect(product.variants[0]?.title).toBe('Default')
    expect(product.variants[0]?.price).toEqual({ amount: 599, currency: 'USD' })
  })

  it('refuses a product with no variant — nothing would be purchasable', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Ghost',
      variants: [],
    })
    expect(res.status).toBe(422)
  })

  it('keeps price and SKU on the variant, never on the product', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await get(admin.accessToken, `/admin/products/${product.id}`)

    expect(res.body.data.price).toBeUndefined()
    expect(res.body.data.sku).toBeUndefined()
    expect(res.body.data.variants[0].price.amount).toBe(599)
  })

  // ── Multi-dimensional variation ───────────────────────────────────────────

  it('varies on two axes without a special column for either', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    expect(pizza.options.map((option) => option.name)).toEqual(['Size', 'Crust'])
    expect(pizza.variants).toHaveLength(6)

    const titles = pizza.variants.map((variant) => variant.title).sort()
    expect(titles).toEqual([
      'Large / Classic',
      'Large / Thin',
      'Medium / Classic',
      'Medium / Thin',
      'Small / Classic',
      'Small / Thin',
    ])

    // Prices differ per combination, which is the whole point of a variant.
    const large = pizza.body.variants.find((v: { title: string }) => v.title === 'Large / Thin')
    expect(large.price.amount).toBe(1449)
  })

  it('adds a third axis to one product without touching the schema', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Wings',
      handle: uniqueHandle('wings'),
      options: [
        { name: 'Size', values: ['6', '12'] },
        { name: 'Sauce', values: ['BBQ', 'Hot'] },
        { name: 'Dip', values: ['Ranch'] },
      ],
      variants: [
        { priceAmount: 599, options: { Size: '6', Sauce: 'BBQ', Dip: 'Ranch' } },
        { priceAmount: 999, options: { Size: '12', Sauce: 'Hot', Dip: 'Ranch' } },
      ],
    })

    expect(res.status).toBe(201)
    expect(res.body.data.variants[1].options).toHaveLength(3)
    expect(res.body.data.variants[1].title).toBe('12 / Hot / Ranch')
  })

  it('rejects a variant that does not choose a value for every option', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Half-specified',
      handle: uniqueHandle('half'),
      options: [
        { name: 'Size', values: ['Small', 'Large'] },
        { name: 'Crust', values: ['Thin'] },
      ],
      variants: [{ priceAmount: 500, options: { Size: 'Small' } }],
    })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_OPTION_SELECTION')
  })

  it('rejects a value that does not belong to the option', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Wrong value',
      handle: uniqueHandle('wrong'),
      options: [{ name: 'Size', values: ['Small'] }],
      variants: [{ priceAmount: 500, options: { Size: 'Enormous' } }],
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_OPTION_SELECTION')
  })

  it('rejects an option the product does not have', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Unknown axis',
      handle: uniqueHandle('unknown'),
      options: [{ name: 'Size', values: ['Small'] }],
      variants: [{ priceAmount: 500, options: { Size: 'Small', Colour: 'Red' } }],
    })
    expect(res.status).toBe(422)
  })

  it('refuses two variants with the same combination', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const duplicate = await post(admin.accessToken, `/admin/products/${pizza.id}/variants`, {
      priceAmount: 1500,
      options: { Size: 'Large', Crust: 'Thin' },
    })

    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe('VARIANT_COMBINATION_EXISTS')
  })

  it('treats the same selection written in a different order as the same variant', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const duplicate = await post(admin.accessToken, `/admin/products/${pizza.id}/variants`, {
      priceAmount: 1500,
      // Crust first this time. Still Large/Thin.
      options: { Crust: 'Thin', Size: 'Large' },
    })
    expect(duplicate.status).toBe(409)
  })

  it('creates the whole product atomically — a bad variant leaves nothing behind', async () => {
    const before = await queryOne<{ count: number }>('SELECT count(*)::int FROM products')

    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Doomed',
      handle: uniqueHandle('doomed'),
      options: [{ name: 'Size', values: ['Small'] }],
      variants: [
        { priceAmount: 500, options: { Size: 'Small' } },
        { priceAmount: 600, options: { Size: 'Nonexistent' } },
      ],
    })

    expect(res.status).toBe(422)
    const after = await queryOne<{ count: number }>('SELECT count(*)::int FROM products')
    expect(after?.count).toBe(before?.count)
  })

  // ── Money ─────────────────────────────────────────────────────────────────

  it('refuses a price that is not a whole number of minor units', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Float price',
      handle: uniqueHandle('float'),
      variants: [{ priceAmount: 12.99 }],
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body)).toMatch(/whole number of minor units/i)
  })

  it('refuses a negative price', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Negative',
      handle: uniqueHandle('negative'),
      variants: [{ priceAmount: -1 }],
    })
    expect(res.status).toBe(422)
  })

  it('refuses a compare-at price that is not above the price', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Fake discount',
      handle: uniqueHandle('fake'),
      variants: [{ priceAmount: 1000, compareAtAmount: 900 }],
    })
    expect(res.status).toBe(422)
  })

  it('returns money as an amount and a currency, never a bare number', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await get(admin.accessToken, `/admin/products/${product.id}`)

    expect(res.body.data.variants[0].price).toEqual({ amount: 599, currency: 'USD' })
    expect(typeof res.body.data.variants[0].price).toBe('object')
  })

  it('stores currency on the variant, so changing the store setting cannot reinterpret it', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)

    const row = await queryOne<{ currency: string; price_amount: number }>(
      'SELECT currency, price_amount FROM product_variants WHERE product_id = $1',
      [product.id],
    )
    expect(row).toEqual({ currency: 'USD', price_amount: 599 })
  })

  it('never accepts a price from a client on a route that should not set one', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await patch(admin.accessToken, `/admin/products/${product.id}`, {
      priceAmount: 1,
    })
    // Price is a variant concern; a product PATCH has no business carrying one.
    expect(res.status).toBe(422)
  })

  // ── Lifecycle, publication, availability: three different things ──────────

  it('starts a product as a draft, unpublished', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await get(admin.accessToken, `/admin/products/${product.id}`)

    expect(res.body.data.status).toBe('draft')
    expect(res.body.data.publications).toEqual([])
  })

  it('refuses to publish a draft', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await post(admin.accessToken, `/admin/products/${product.id}/publish`)

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_NOT_PUBLISHABLE')
  })

  it('lets an active product be unpublished without being archived', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await post(admin.accessToken, `/admin/products/${product.id}/unpublish`, {})
    expect(res.status).toBe(200)
    // Still active. Publication and lifecycle are different questions.
    expect(res.body.data.status).toBe('active')
    expect(res.body.data.publications).toEqual([])
  })

  it('represents "active, published, nothing sellable" — the sold-out state', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    // Availability is a third axis: the variant is switched off, the product is
    // untouched.
    const variantId = product.variants[0]!.id
    await patch(admin.accessToken, `/admin/variants/${variantId}`, { isActive: false })

    const admin_view = await get(admin.accessToken, `/admin/products/${product.id}`)
    expect(admin_view.body.data.status).toBe('active')
    expect(admin_view.body.data.publications).toHaveLength(1)

    const storefront = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
    expect(storefront.status).toBe(200)
    expect(storefront.body.data.available).toBe(false)
    expect(storefront.body.data.variants).toHaveLength(0)
  })

  it('unpublishes everywhere when a product is archived', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const res = await post(admin.accessToken, `/admin/products/${product.id}/archive`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('archived')
    expect(res.body.data.publications).toEqual([])
    expect(res.body.data.archivedAt).toBeTruthy()
  })

  it('restores an archived product to draft, not straight back to the storefront', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)
    await post(admin.accessToken, `/admin/products/${product.id}/archive`)

    const res = await post(admin.accessToken, `/admin/products/${product.id}/restore`)
    expect(res.body.data.status).toBe('draft')
    expect(res.body.data.publications).toEqual([])
  })

  it('refuses to edit an archived product', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await post(admin.accessToken, `/admin/products/${product.id}/archive`)

    const res = await patch(admin.accessToken, `/admin/products/${product.id}`, { title: 'New' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_ARCHIVED')
  })

  it('publishing twice is not an error and does not duplicate the publication', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const again = await post(admin.accessToken, `/admin/products/${product.id}/publish`, {})
    expect(again.status).toBe(200)
    expect(again.body.data.publications).toHaveLength(1)
  })

  it('models publication as rows, so a second channel is additive', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const rows = await query<{ sales_channel_id: string }>(
      'SELECT sales_channel_id FROM product_publications WHERE product_id = $1',
      [product.id],
    )
    expect(rows).toHaveLength(1)

    // There is no boolean anywhere that would have to become a table later.
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`,
    )
    const names = columns.map((c) => c.column_name)
    expect(names).not.toContain('published')
    expect(names).not.toContain('published_at')
  })

  // ── Nothing is destroyed ──────────────────────────────────────────────────

  it('archives a variant instead of deleting it, so an order could still resolve it', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const variantId = pizza.variants[0]!.id

    const res = await request(app)
      .delete(`/api/v1/admin/variants/${variantId}`)
      .set('Authorization', bearer(admin.accessToken))
    expect(res.status).toBe(204)

    const row = await queryOne<{ archived_at: Date | null; is_active: boolean }>(
      'SELECT archived_at, is_active FROM product_variants WHERE id = $1',
      [variantId],
    )
    // The row survives. This is the property carts and orders depend on.
    expect(row).toBeTruthy()
    expect(row?.archived_at).not.toBeNull()
    expect(row?.is_active).toBe(false)
  })

  it('refuses to archive a product’s only variant', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)

    const res = await request(app)
      .delete(`/api/v1/admin/variants/${product.variants[0]!.id}`)
      .set('Authorization', bearer(admin.accessToken))

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('LAST_VARIANT_PROTECTED')
  })

  it('refuses to activate a product with no live variant', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    // Archive five of six, then the product, then try to activate.
    for (const variant of pizza.variants.slice(0, 5)) {
      await request(app)
        .delete(`/api/v1/admin/variants/${variant.id}`)
        .set('Authorization', bearer(admin.accessToken))
    }
    await post(admin.accessToken, `/admin/products/${pizza.id}/archive`)
    await request(app)
      .delete(`/api/v1/admin/variants/${pizza.variants[5]!.id}`)
      .set('Authorization', bearer(admin.accessToken))
    await post(admin.accessToken, `/admin/products/${pizza.id}/restore`)

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/activate`)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_NOT_PUBLISHABLE')
  })

  it('offers no way to delete a product at all', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const res = await request(app)
      .delete(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', bearer(admin.accessToken))
    expect(res.status).toBe(404)
  })

  // ── Options ───────────────────────────────────────────────────────────────

  it('refuses to restructure options while variants select them', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const res = await request(app)
      .put(`/api/v1/admin/products/${pizza.id}/options`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ options: [{ name: 'Size', values: ['Small'] }] })

    expect(res.status).toBe(409)
  })

  it('rejects duplicate option names and duplicate values', async () => {
    const duplicateNames = await post(admin.accessToken, '/admin/products', {
      title: 'Dup options',
      handle: uniqueHandle('dup-a'),
      options: [
        { name: 'Size', values: ['S'] },
        { name: 'size', values: ['L'] },
      ],
      variants: [{ priceAmount: 100, options: { Size: 'S' } }],
    })
    expect(duplicateNames.status).toBe(422)

    const duplicateValues = await post(admin.accessToken, '/admin/products', {
      title: 'Dup values',
      handle: uniqueHandle('dup-b'),
      options: [{ name: 'Size', values: ['Small', 'small'] }],
      variants: [{ priceAmount: 100, options: { Size: 'Small' } }],
    })
    expect(duplicateValues.status).toBe(422)
  })

  // ── Variants ──────────────────────────────────────────────────────────────

  it('adds a variant to an existing product', async () => {
    const res0 = await post(admin.accessToken, '/admin/products', {
      title: 'Shake',
      handle: uniqueHandle('shake'),
      options: [{ name: 'Size', values: ['Regular', 'Large'] }],
      variants: [{ priceAmount: 299, options: { Size: 'Regular' } }],
    })
    const productId = res0.body.data.id

    const res = await post(admin.accessToken, `/admin/products/${productId}/variants`, {
      priceAmount: 399,
      sku: 'SHAKE-L',
      options: { Size: 'Large' },
    })

    expect(res.status).toBe(201)
    expect(res.body.data.title).toBe('Large')
    expect(res.body.data.sku).toBe('SHAKE-L')
  })

  it('refuses a duplicate SKU across the whole catalogue', async () => {
    await createSimpleProduct(app, admin.accessToken, {
      handle: uniqueHandle('a'),
      variants: [{ priceAmount: 100, sku: 'SHARED-SKU' }],
    })
    const second = await post(admin.accessToken, '/admin/products', {
      title: 'Second',
      handle: uniqueHandle('b'),
      variants: [{ priceAmount: 200, sku: 'SHARED-SKU' }],
    })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe('SKU_TAKEN')
  })

  it('updates a variant’s price and records what changed', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const variantId = product.variants[0]!.id

    const res = await patch(admin.accessToken, `/admin/variants/${variantId}`, {
      priceAmount: 649,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.price.amount).toBe(649)

    const audit = await queryOne<{ action: string; before: any; after: any }>(
      `SELECT action, before, after FROM audit_logs
        WHERE resource_id = $1 ORDER BY id DESC LIMIT 1`,
      [variantId],
    )
    expect(audit?.action).toBe('variant.updated')
    expect(audit?.before.priceAmount).toBe(599)
    expect(audit?.after.priceAmount).toBe(649)
  })

  it('refuses to edit an archived variant', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const variantId = pizza.variants[0]!.id
    await request(app)
      .delete(`/api/v1/admin/variants/${variantId}`)
      .set('Authorization', bearer(admin.accessToken))

    const res = await patch(admin.accessToken, `/admin/variants/${variantId}`, { priceAmount: 1 })
    expect(res.status).toBe(422)
  })

  // ── Events ────────────────────────────────────────────────────────────────

  it('publishes the events an integration would need', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)
    await patch(admin.accessToken, `/admin/products/${product.id}`, { title: 'Renamed' })
    await post(admin.accessToken, `/admin/products/${product.id}/unpublish`, {})

    const names = await eventNames()
    expect(names).toContain('product.created')
    expect(names).toContain('product.status_changed')
    expect(names).toContain('product.published')
    expect(names).toContain('product.updated')
    expect(names).toContain('product.unpublished')
  })

  it('names the channel on a publication event rather than a boolean', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    await publishProduct(app, admin.accessToken, product.id)

    const event = await queryOne<{ payload: { channelKey: string } }>(
      `SELECT payload FROM domain_events WHERE name = 'product.published'`,
    )
    expect(event?.payload.channelKey).toBe('storefront')
  })

  // ── Authorisation ─────────────────────────────────────────────────────────

  it('separates writing from publishing', async () => {
    const product = await createSimpleProduct(app, admin.accessToken)
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    // staff has catalog:read only.
    expect((await get(staff.accessToken, '/admin/products')).status).toBe(200)
    expect((await post(staff.accessToken, '/admin/products', {})).status).toBe(403)
    expect(
      (await post(staff.accessToken, `/admin/products/${product.id}/publish`, {})).status,
    ).toBe(403)
  })

  it('is not reachable anonymously', async () => {
    expect((await request(app).get('/api/v1/admin/products')).status).toBe(401)
    expect((await request(app).post('/api/v1/admin/products').send({})).status).toBe(401)
  })


  // ── List ordering ─────────────────────────────────────────────────────────

  it('orders the admin list newest-first by default', async () => {
    const first = await createSimpleProduct(app, admin.accessToken, { title: 'Alpha' })
    const second = await createSimpleProduct(app, admin.accessToken, { title: 'Beta' })

    const res = await get(admin.accessToken, '/admin/products')
    expect(res.status).toBe(200)
    const ids = (res.body.data as Array<{ id: string }>).map((row) => row.id)
    expect(ids.slice(0, 2)).toEqual([second.id, first.id])
  })

  it('sorts by title in either direction', async () => {
    await createSimpleProduct(app, admin.accessToken, { title: 'Cherry' })
    await createSimpleProduct(app, admin.accessToken, { title: 'apple' })
    await createSimpleProduct(app, admin.accessToken, { title: 'Banana' })

    const asc = await get(admin.accessToken, '/admin/products?sort=title&direction=asc')
    // Case-insensitive: 'apple' must not sort after 'Cherry' merely for being
    // lower case, which is what a plain byte comparison would do.
    expect((asc.body.data as Array<{ title: string }>).map((row) => row.title)).toEqual([
      'apple',
      'Banana',
      'Cherry',
    ])

    const desc = await get(admin.accessToken, '/admin/products?sort=title&direction=desc')
    expect((desc.body.data as Array<{ title: string }>).map((row) => row.title)).toEqual([
      'Cherry',
      'Banana',
      'apple',
    ])
  })

  it('refuses a sort key that is not in the allowlist', async () => {
    // The value reaches an ORDER BY, so anything outside the enum is a 422 at
    // the boundary rather than a string interpolated into SQL.
    const res = await get(admin.accessToken, '/admin/products?sort=price_amount%3B+DROP+TABLE')
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('pages stably when several products share a sort value', async () => {
    // Same title on every row: without the id tiebreaker the two pages could
    // return the same product twice and miss another entirely.
    for (let index = 0; index < 5; index += 1) {
      await createSimpleProduct(app, admin.accessToken, { title: 'Identical' })
    }

    const first = await get(admin.accessToken, '/admin/products?sort=title&limit=3&page=1')
    const second = await get(admin.accessToken, '/admin/products?sort=title&limit=3&page=2')
    const ids = [
      ...(first.body.data as Array<{ id: string }>).map((row) => row.id),
      ...(second.body.data as Array<{ id: string }>).map((row) => row.id),
    ]
    expect(new Set(ids).size).toBe(5)
  })


  // ── Option values on a live product ───────────────────────────────────────

  it('appends a value to an option while variants are live', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')

    const res = await post(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values`,
      { value: 'Family' },
    )

    expect(res.status).toBe(201)
    const size = optionNamed(res.body.data.options, 'Size')
    expect(size.values.map((value: { value: string }) => value.value)).toEqual([
      'Small',
      'Medium',
      'Large',
      'Family',
    ])

    // Additive: no variant was invented for the new value, and none was harmed.
    expect(res.body.data.variants).toHaveLength(6)
  })

  it('lets a variant be created against a value added after the fact', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')

    await post(admin.accessToken, `/admin/products/${pizza.id}/options/${sizeOption.id}/values`, {
      value: 'Family',
    })

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/variants`, {
      priceAmount: 1899,
      options: { Size: 'Family', Crust: 'Thin' },
    })

    expect(res.status).toBe(201)
    expect(res.body.data.title).toBe('Family / Thin')
  })

  it('refuses a duplicate value, case-insensitively', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')

    const res = await post(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values`,
      { value: 'lArGe' },
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALREADY_EXISTS')
  })

  it('refuses an option id belonging to a different product', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const other = await createPizza(app, admin.accessToken)
    const otherOption = optionNamed(other.options, 'Size')

    const res = await post(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${otherOption.id}/values`,
      { value: 'Family' },
    )
    expect(res.status).toBe(404)
  })

  it('removes a value nothing selects', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')

    const added = await post(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values`,
      { value: 'Family' },
    )
    const familyId = valueNamed(optionNamed(added.body.data.options, 'Size'), 'Family').id

    const res = await del(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values/${familyId}`,
    )

    expect(res.status).toBe(200)
    const size = optionNamed(res.body.data.options, 'Size')
    expect(size.values.map((value: { value: string }) => value.value)).toEqual([
      'Small',
      'Medium',
      'Large',
    ])
  })

  it('refuses to remove a value a live variant still selects', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')
    const largeId = valueNamed(sizeOption, 'Large').id

    const res = await del(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values/${largeId}`,
    )

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OPTION_VALUE_IN_USE')
    expect(res.body.message).toMatch(/2 variant\(s\) still use "Large"/)
  })

  it('still refuses once the variants using it are archived, because the value is their history', async () => {
    // `variant_option_values` holds the selection with ON DELETE RESTRICT. An
    // archived variant is resolvable from an order line and must keep being able
    // to describe itself, so the API refuses rather than letting a foreign-key
    // violation surface as a 500.
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')
    const largeId = valueNamed(sizeOption, 'Large').id

    for (const variant of pizza.variants as Array<{ id: string; title: string }>) {
      if (variant.title.startsWith('Large')) {
        expect((await del(admin.accessToken, `/admin/variants/${variant.id}`)).status).toBe(204)
      }
    }

    const res = await del(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values/${largeId}`,
    )
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('OPTION_VALUE_IN_USE')
    expect(res.body.message).toMatch(/archived variant/)
  })

  it('refuses option-value writes without catalog:write', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    expect(
      (
        await post(staff.accessToken, `/admin/products/${pizza.id}/options/${sizeOption.id}/values`, {
          value: 'Family',
        })
      ).status,
    ).toBe(403)
  })

  it('refuses option-value writes on an archived product', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const sizeOption = optionNamed(pizza.options, 'Size')
    await post(admin.accessToken, `/admin/products/${pizza.id}/archive`)

    const res = await post(
      admin.accessToken,
      `/admin/products/${pizza.id}/options/${sizeOption.id}/values`,
      { value: 'Family' },
    )
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_ARCHIVED')
  })

  // ── A whole new axis on a live product ────────────────────────────────────

  it('adds an axis to a product that had none, and every variant selects on it', async () => {
    const burger = await createSimpleProduct(app, admin.accessToken)

    const res = await post(admin.accessToken, `/admin/products/${burger.id}/options`, {
      name: 'Bun',
      values: ['Brioche', 'Sourdough'],
      appliesToExisting: 'Brioche',
    })

    expect(res.status).toBe(201)
    const bun = optionNamed(res.body.data.options, 'Bun')
    expect(bun.values.map((value: { value: string }) => value.value)).toEqual([
      'Brioche',
      'Sourdough',
    ])

    // The variant that existed before the axis now selects a value on it —
    // "every variant chooses one value for every option" is the invariant the
    // whole model rests on, and adding an axis must not be the hole in it.
    const variants = res.body.data.variants as Array<{
      options: Array<{ name: string; value: string }>
    }>
    expect(variants).toHaveLength(1)
    expect(variants[0]!.options).toHaveLength(1)
    expect(variants[0]!.options[0]).toMatchObject({ name: 'Bun', value: 'Brioche' })

    // And the product is now a variant product: a second combination is sellable.
    const second = await post(admin.accessToken, `/admin/products/${burger.id}/variants`, {
      priceAmount: 699,
      options: { Bun: 'Sourdough' },
    })
    expect(second.status).toBe(201)
  })

  it('adds a second axis to a product that already varies, keeping combinations distinct', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
      name: 'Cheese',
      values: ['Mozzarella', 'Vegan'],
      appliesToExisting: 'Mozzarella',
    })

    expect(res.status).toBe(201)
    expect(res.body.data.options).toHaveLength(3)

    // All six existing variants took the same value, so no two of them collided
    // on `variant_combination_is_unique` — and each now carries three
    // selections rather than two.
    const variants = res.body.data.variants as Array<{
      options: Array<{ name: string; value: string }>
    }>
    expect(variants).toHaveLength(6)
    for (const variant of variants) {
      expect(variant.options).toHaveLength(3)
      expect(variant.options.find((option) => option.name === 'Cheese')?.value).toBe('Mozzarella')
    }

    const signatures = await query<{ option_signature: string }>(
      `SELECT option_signature FROM product_variants WHERE product_id = $1`,
      [pizza.id],
    )
    expect(new Set(signatures.map((row) => row.option_signature)).size).toBe(6)
  })

  it('carries an archived variant onto the new axis too', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const doomed = pizza.variants[0]!
    await del(admin.accessToken, `/admin/variants/${doomed.id}`)

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
      name: 'Cheese',
      values: ['Mozzarella'],
      appliesToExisting: 'Mozzarella',
    })
    expect(res.status).toBe(201)

    // An archived variant is still resolved from an order line. Leaving it with
    // a gap would mean it could no longer describe what it was.
    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM variant_option_values WHERE variant_id = $1`,
      [doomed.id],
    )
    expect(rows[0]!.count).toBe(3)
  })

  it('refuses a value for existing variants that is not one of the new option\'s values', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
      name: 'Cheese',
      values: ['Mozzarella', 'Vegan'],
      appliesToExisting: 'Cheddar',
    })
    expect(res.status).toBe(422)
  })

  it('refuses a duplicate option name, case-insensitively', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
      name: 'size',
      values: ['Huge'],
      appliesToExisting: 'Huge',
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALREADY_EXISTS')
  })

  it('refuses a fourth axis', async () => {
    const pizza = await createPizza(app, admin.accessToken)

    for (const name of ['Cheese', 'Sauce']) {
      const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
        name,
        values: ['Standard'],
        appliesToExisting: 'Standard',
      })
      expect(res.status).toBe(name === 'Cheese' ? 201 : 409)
    }
  })

  it('refuses adding an axis without catalog:write, or on an archived product', async () => {
    const pizza = await createPizza(app, admin.accessToken)
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    expect(
      (
        await post(staff.accessToken, `/admin/products/${pizza.id}/options`, {
          name: 'Cheese',
          values: ['Mozzarella'],
          appliesToExisting: 'Mozzarella',
        })
      ).status,
    ).toBe(403)

    await post(admin.accessToken, `/admin/products/${pizza.id}/archive`)
    const res = await post(admin.accessToken, `/admin/products/${pizza.id}/options`, {
      name: 'Cheese',
      values: ['Mozzarella'],
      appliesToExisting: 'Mozzarella',
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PRODUCT_ARCHIVED')
  })

  // ── Category linkage ──────────────────────────────────────────────────────

  it('puts a product in exactly one category', async () => {
    const category = await createCategory(app, admin.accessToken)
    const product = await createSimpleProduct(app, admin.accessToken, {
      categoryId: category.id,
    })

    const res = await get(admin.accessToken, `/admin/products/${product.id}`)
    expect(res.body.data.category.handle).toBe(category.handle)

    // There is no product↔category junction: taxonomy is a single answer.
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'product_categories'`,
    )
    expect(tables).toHaveLength(0)
  })

  it('rejects a category that does not exist', async () => {
    const res = await post(admin.accessToken, '/admin/products', {
      title: 'Orphan',
      handle: uniqueHandle('orphan'),
      categoryId: '00000000-0000-4000-8000-000000000000',
      variants: [{ priceAmount: 100 }],
    })
    expect(res.status).toBe(422)
  })
})
