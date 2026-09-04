/**
 * Custom fields, end to end (§5.4).
 *
 * The whole value of typed metafields over a jsonb bag is that four things are
 * true, so those are what this pins down:
 *
 *   • **The type is enforced.** "twelve" is not an integer, and 12.5 is not one
 *     either — it is refused rather than quietly rounded.
 *   • **Private stays private.** A field is invisible to the storefront until
 *     somebody says otherwise, and the default is invisible.
 *   • **Permissions follow the record, not the field.** Defining a customer
 *     field and writing to a customer are different rights.
 *   • **Deleting a definition is honest about what it destroys.**
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import { sellableProduct } from '../factories/commerce.js'
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

describeIfDatabase('metafields', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const get = (path: string, token = owner.accessToken) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(token))
  const post = (path: string, body: object = {}, token = owner.accessToken) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(token)).send(body)
  const put = (path: string, body: object = {}, token = owner.accessToken) =>
    request(app).put(`/api/v1${path}`).set('Authorization', bearer(token)).send(body)
  const patch = (path: string, body: object = {}, token = owner.accessToken) =>
    request(app).patch(`/api/v1${path}`).set('Authorization', bearer(token)).send(body)
  const del = (path: string, token = owner.accessToken) =>
    request(app).delete(`/api/v1${path}`).set('Authorization', bearer(token))

  /** Defines a field and returns it. Defaults to a public product text field. */
  async function define(overrides: Record<string, unknown> = {}) {
    const res = await post('/admin/metafields/definitions', {
      ownerType: 'product',
      namespace: 'custom',
      key: 'ingredients',
      name: 'Ingredients',
      type: 'multi_line_text',
      storefrontVisible: true,
      ...overrides,
    })
    if (res.status !== 201) throw new Error(`define failed: ${JSON.stringify(res.body)}`)
    return res.body.data as { id: string; namespace: string; key: string }
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

  // ── Defining a field ──────────────────────────────────────────────────────

  describe('definitions', () => {
    it('defines a field and lists it against its kind of record', async () => {
      await define()

      const res = await get('/admin/metafields/definitions?ownerType=product')
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({
        namespace: 'custom',
        key: 'ingredients',
        type: 'multi_line_text',
        // Nobody has filled it in yet, and the admin needs that number before
        // offering to delete the field.
        valueCount: 0,
      })
    })

    it('is private until somebody says otherwise', async () => {
      const res = await post('/admin/metafields/definitions', {
        ownerType: 'product',
        namespace: 'custom',
        key: 'supplier_code',
        name: 'Supplier code',
        type: 'single_line_text',
      })
      expect(res.status).toBe(201)
      expect(res.body.data.storefrontVisible).toBe(false)
    })

    it('refuses a second field with the same namespace and key', async () => {
      await define()
      const again = await post('/admin/metafields/definitions', {
        ownerType: 'product',
        namespace: 'custom',
        key: 'ingredients',
        name: 'Ingredients again',
        type: 'single_line_text',
      })

      expect(again.status).toBe(409)
      expect(again.body.message).toMatch(/already exists/i)
    })

    it('allows the same key on a different kind of record', async () => {
      await define()
      const onCollections = await post('/admin/metafields/definitions', {
        ownerType: 'collection',
        namespace: 'custom',
        key: 'ingredients',
        name: 'Ingredients',
        type: 'multi_line_text',
      })
      expect(onCollections.status).toBe(201)
    })

    it('refuses a key a storefront template could not address', async () => {
      const res = await post('/admin/metafields/definitions', {
        ownerType: 'product',
        namespace: 'custom',
        key: 'How To Use',
        name: 'How to use',
        type: 'multi_line_text',
      })
      expect(res.status).toBe(422)
    })

    it('refuses bounds that contradict each other', async () => {
      const res = await post('/admin/metafields/definitions', {
        ownerType: 'product',
        namespace: 'custom',
        key: 'shelf_life',
        name: 'Shelf life',
        type: 'integer',
        validations: { min: 100, max: 10 },
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/minimum cannot be greater/i)
    })

    it('renames a field without touching what it is', async () => {
      const definition = await define()

      const res = await patch(`/admin/metafields/definitions/${definition.id}`, {
        name: 'What is in it',
      })
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ name: 'What is in it', key: 'ingredients' })
    })

    it('refuses to change the type out from under stored values', async () => {
      const definition = await define()

      // Values are already stored against the type. Changing it would not
      // convert anything — it would leave every value invalid under its own
      // definition, so the patch does not accept the field at all.
      const res = await patch(`/admin/metafields/definitions/${definition.id}`, {
        type: 'integer',
      })
      expect(res.status).toBe(422)
    })
  })

  // ── Types are actually enforced ───────────────────────────────────────────

  describe('what a field will accept', () => {
    let productId: string

    beforeEach(async () => {
      const product = await sellableProduct(app, owner.accessToken)
      productId = product.id
    })

    const setValue = async (definitionId: string, value: unknown) =>
      put(`/admin/metafields/product/${productId}`, { values: [{ definitionId, value }] })

    it('stores a number as a number, not as the string that was posted', async () => {
      const definition = await define({ key: 'shelf_life_months', type: 'integer' })

      const res = await setValue(definition.id, '24')
      expect(res.status).toBe(200)
      // The type survived the round trip: a storefront comparing this against a
      // number does not have to know it came from a form.
      expect(res.body.data[0].value).toBe(24)
    })

    it('refuses a whole-number field a fraction rather than rounding it', async () => {
      const definition = await define({ key: 'shelf_life_months', type: 'integer' })

      const res = await setValue(definition.id, 12.5)
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/whole number/i)
    })

    it('refuses text where a number belongs', async () => {
      const definition = await define({ key: 'shelf_life_months', type: 'integer' })
      const res = await setValue(definition.id, 'twelve')
      expect(res.status).toBe(422)
    })

    it('enforces the bounds the definition carries', async () => {
      const definition = await define({
        key: 'spf',
        type: 'integer',
        validations: { min: 0, max: 50 },
      })

      expect((await setValue(definition.id, 30)).status).toBe(200)
      const tooHigh = await setValue(definition.id, 90)
      expect(tooHigh.status).toBe(422)
      expect(tooHigh.body.message).toMatch(/50 or less/i)
    })

    it('holds a text field to its list of choices', async () => {
      const definition = await define({
        key: 'skin_type',
        type: 'single_line_text',
        validations: { choices: ['Dry', 'Oily', 'Combination'] },
      })

      expect((await setValue(definition.id, 'Oily')).status).toBe(200)
      const wrong = await setValue(definition.id, 'Purple')
      expect(wrong.status).toBe(422)
      expect(wrong.body.message).toMatch(/must be one of/i)
    })

    it('refuses a link that would run script if it were rendered', async () => {
      const definition = await define({ key: 'guide', type: 'url' })

      // A storefront-visible URL field ends up in an href. Refusing the scheme
      // here is what stops a merchant-editable field becoming stored XSS.
      const res = await setValue(definition.id, 'javascript:alert(1)')
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/http or https/i)
    })

    it('refuses a date that never happened', async () => {
      const definition = await define({ key: 'launch_on', type: 'date' })

      expect((await setValue(definition.id, '2026-02-28')).status).toBe(200)
      expect((await setValue(definition.id, '2026-02-31')).status).toBe(422)
    })

    it('keeps a required field from being emptied', async () => {
      const definition = await define({ key: 'ingredients', required: true })
      await setValue(definition.id, 'Water, glycerin')

      const res = await setValue(definition.id, null)
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/required/i)
    })

    it('clears an optional field when it is set to null', async () => {
      const definition = await define()
      await setValue(definition.id, 'Water, glycerin')

      const cleared = await setValue(definition.id, null)
      expect(cleared.status).toBe(200)
      expect(cleared.body.data[0].value).toBeNull()

      const rows = await query(`SELECT id FROM metafield_values WHERE definition_id = $1`, [
        definition.id,
      ])
      expect(rows).toHaveLength(0)
    })

    it('writes nothing at all when one field in the batch is bad', async () => {
      const good = await define({ key: 'ingredients' })
      const bad = await define({ key: 'spf', type: 'integer' })

      const res = await put(`/admin/metafields/product/${productId}`, {
        values: [
          { definitionId: good.id, value: 'Water' },
          { definitionId: bad.id, value: 'not a number' },
        ],
      })

      expect(res.status).toBe(422)
      // The first value must not have landed: a form saves as a whole, and half
      // a save is a product describing itself inconsistently.
      const rows = await query(`SELECT id FROM metafield_values`, [])
      expect(rows).toHaveLength(0)
    })

    it('refuses a field that belongs to a different kind of record', async () => {
      const onCustomers = await define({
        ownerType: 'customer',
        key: 'loyalty_tier',
        type: 'single_line_text',
      })

      const res = await put(`/admin/metafields/product/${productId}`, {
        values: [{ definitionId: onCustomers.id, value: 'Gold' }],
      })
      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/does not apply/i)
    })

    it('refuses a value written against a record that does not exist', async () => {
      const definition = await define()
      const res = await put(`/admin/metafields/product/0199a0e0-0000-7000-8000-00000000dead`, {
        values: [{ definitionId: definition.id, value: 'Water' }],
      })
      expect(res.status).toBe(404)
    })
  })

  // ── The storefront boundary ───────────────────────────────────────────────

  describe('what customers can see', () => {
    it('shows a public field on the product page and hides a private one', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const publicField = await define({ key: 'ingredients', storefrontVisible: true })
      const privateField = await define({
        key: 'supplier_code',
        type: 'single_line_text',
        storefrontVisible: false,
      })

      await put(`/admin/metafields/product/${product.id}`, {
        values: [
          { definitionId: publicField.id, value: 'Water, glycerin' },
          { definitionId: privateField.id, value: 'ACME-1188' },
        ],
      })

      const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
      expect(res.status).toBe(200)

      const keys = res.body.data.metafields.map((field: { key: string }) => field.key)
      expect(keys).toContain('ingredients')
      expect(keys).not.toContain('supplier_code')
      // And the value itself is nowhere in the response, not merely unlisted.
      expect(JSON.stringify(res.body)).not.toContain('ACME-1188')
    })

    it('stops showing a field the moment it is made private again', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const definition = await define({ key: 'ingredients', storefrontVisible: true })
      await put(`/admin/metafields/product/${product.id}`, {
        values: [{ definitionId: definition.id, value: 'Water' }],
      })

      await patch(`/admin/metafields/definitions/${definition.id}`, { storefrontVisible: false })

      const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
      expect(res.body.data.metafields).toHaveLength(0)
    })

    it('carries a variant’s own public fields', async () => {
      const product = await sellableProduct(app, owner.accessToken)
      const variantId = product.variants[0]!.id
      const definition = await define({
        ownerType: 'variant',
        key: 'shade_hex',
        type: 'single_line_text',
        storefrontVisible: true,
      })

      await put(`/admin/metafields/variant/${variantId}`, {
        values: [{ definitionId: definition.id, value: '#C1443A' }],
      })

      const res = await request(app).get(`/api/v1/storefront/products/${product.handle}`)
      const variant = res.body.data.variants.find((v: { id: string }) => v.id === variantId)
      expect(variant.metafields).toEqual([
        { namespace: 'custom', key: 'shade_hex', type: 'single_line_text', value: '#C1443A' },
      ])
    })
  })

  // ── Who may do what ───────────────────────────────────────────────────────

  describe('permissions follow the record, not the field', () => {
    it('lets someone who can edit the catalogue fill in a product field', async () => {
      // An admin holds catalog:write. That, not a metafields permission, is
      // what decides whether they may describe a product.
      const product = await sellableProduct(app, owner.accessToken)
      const definition = await define()
      const merchandiser = await createUserAndLogin(app, { roles: ['admin'] })

      const res = await put(
        `/admin/metafields/product/${product.id}`,
        { values: [{ definitionId: definition.id, value: 'Water' }] },
        merchandiser.accessToken,
      )
      expect(res.status).toBe(200)
    })

    it('refuses a customer field to someone who may not edit customers', async () => {
      const definition = await define({
        ownerType: 'customer',
        key: 'loyalty_tier',
        type: 'single_line_text',
      })
      const shopper = await createUserAndLogin(app)
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      // Staff can read customers but not write them, so the value is refused
      // even though the field itself is perfectly ordinary.
      const res = await put(
        `/admin/metafields/customer/${shopper.user.id}`,
        { values: [{ definitionId: definition.id, value: 'Gold' }] },
        staff.accessToken,
      )
      expect(res.status).toBe(403)
    })

    it('keeps defining fields behind the settings permission', async () => {
      // Staff run the order queue and hold no settings permission at all —
      // they can fill fields in, but what fields exist is not theirs to decide.
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      const res = await post(
        '/admin/metafields/definitions',
        {
          ownerType: 'product',
          namespace: 'custom',
          key: 'ingredients',
          name: 'Ingredients',
          type: 'multi_line_text',
        },
        staff.accessToken,
      )
      expect(res.status).toBe(403)
    })
  })

  // ── Removing a field ──────────────────────────────────────────────────────

  describe('deleting a definition', () => {
    it('says how many values it destroyed', async () => {
      const a = await sellableProduct(app, owner.accessToken)
      const b = await sellableProduct(app, owner.accessToken)
      const definition = await define()

      for (const product of [a, b]) {
        await put(`/admin/metafields/product/${product.id}`, {
          values: [{ definitionId: definition.id, value: 'Water' }],
        })
      }

      const res = await del(`/admin/metafields/definitions/${definition.id}`)
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ deletedValues: 2 })

      const rows = await query(`SELECT id FROM metafield_values`, [])
      expect(rows).toHaveLength(0)
    })

    it('takes a customer’s values with the customer', async () => {
      // The case the schema was shaped around. Erase somebody under a data
      // protection request and whatever was typed into a field called "notes"
      // has to go with them — enforced by the database, not remembered by a
      // cleanup job that might not run.
      const shopper = await createUserAndLogin(app)
      const definition = await define({
        ownerType: 'customer',
        key: 'loyalty_tier',
        type: 'single_line_text',
      })
      await put(`/admin/metafields/customer/${shopper.user.id}`, {
        values: [{ definitionId: definition.id, value: 'Gold' }],
      })

      await query(`DELETE FROM users WHERE id = $1`, [shopper.user.id])

      const remaining = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM metafield_values`,
        [],
      )
      expect(remaining?.count).toBe(0)
    })
  })
})
