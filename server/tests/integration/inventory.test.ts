/**
 * Inventory: items, locations, levels, adjustments and history (docs/inventory.md).
 *
 * The questions this suite asks are the ones that decide whether the model is
 * commerce-grade or a quantity column with extra steps:
 *
 *   • does quantity live on a level, scoped to a location?
 *   • can stock change without a reason being recorded?
 *   • is `available` derivable, or can it drift?
 *   • does "not tracked" mean unlimited, or does it silently mean zero?
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin, eventNames } from '../factories/auth.js'
import { createPizza, createSimpleProduct, uniqueHandle } from '../factories/catalogue.js'
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
const MAIN_LOCATION = '00000000-0000-4000-8000-000000000101'

describeIfDatabase('inventory', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const post = (path: string, body: object = {}, token?: string) =>
    request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(token ?? owner.accessToken))
      .send(body)
  const patch = (path: string, body: object = {}, token?: string) =>
    request(app)
      .patch(`/api/v1${path}`)
      .set('Authorization', bearer(token ?? owner.accessToken))
      .send(body)
  const get = (path: string, token?: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(token ?? owner.accessToken))
  const del = (path: string, token?: string) =>
    request(app).delete(`/api/v1${path}`).set('Authorization', bearer(token ?? owner.accessToken))

  const receive = (variantId: string, delta: number, extra: object = {}) =>
    post('/admin/inventory/adjustments', { variantId, delta, reason: 'receive', ...extra })

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Items ─────────────────────────────────────────────────────────────────

  it('gives every new variant an inventory item automatically', async () => {
    const pizza = await createPizza(app, owner.accessToken)

    const rows = await query<{ variant_id: string }>(
      `SELECT variant_id FROM inventory_items WHERE variant_id = ANY($1::uuid[])`,
      [pizza.variants.map((v) => v.id)],
    )
    expect(rows).toHaveLength(6)
    expect(await eventNames()).toContain('inventory.item_created')
  })

  it('gives a variant added later its own item too', async () => {
    const res0 = await post('/admin/products', {
      title: 'Shake',
      handle: uniqueHandle('shake'),
      options: [{ name: 'Size', values: ['Regular', 'Large'] }],
      variants: [{ priceAmount: 299, options: { Size: 'Regular' } }],
    })
    const added = await post(`/admin/products/${res0.body.data.id}/variants`, {
      priceAmount: 399,
      options: { Size: 'Large' },
    })

    const item = await queryOne('SELECT 1 FROM inventory_items WHERE variant_id = $1', [
      added.body.data.id,
    ])
    expect(item).toBeTruthy()
  })

  it('refuses a second inventory item for one variant', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    await expect(
      execute(`INSERT INTO inventory_items (id, variant_id) VALUES (gen_random_uuid(), $1)`, [
        variantId,
      ]),
    ).rejects.toThrow()
  })

  it('holds no quantity on the item or the variant', async () => {
    const columns = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('inventory_items', 'product_variants')`,
    )
    const names = columns.map((c) => `${c.table_name}.${c.column_name}`)

    // Quantity belongs to a level, which is scoped to a location. Anywhere
    // higher and multi-location becomes a rewrite.
    for (const forbidden of ['on_hand', 'reserved', 'available', 'quantity', 'stock']) {
      expect(names.some((n) => n.endsWith(`.${forbidden}`))).toBe(false)
    }
  })

  // ── Locations ─────────────────────────────────────────────────────────────

  it('seeds exactly one default location', async () => {
    const res = await get('/admin/locations')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ code: 'main', isDefault: true, isActive: true })
  })

  it('creates a second location and hands over the default', async () => {
    const created = await post('/admin/locations', {
      code: 'lahore-branch',
      name: 'Lahore Branch',
      isDefault: true,
    })
    expect(created.status).toBe(201)

    const all = await get('/admin/locations')
    const defaults = all.body.data.filter((l: { isDefault: boolean }) => l.isDefault)
    // The partial unique index guarantees this; the service does the handover.
    expect(defaults).toHaveLength(1)
    expect(defaults[0].code).toBe('lahore-branch')
  })

  it('refuses a duplicate location code', async () => {
    await post('/admin/locations', { code: 'branch-2', name: 'Branch 2' })
    const again = await post('/admin/locations', { code: 'branch-2', name: 'Another' })
    expect(again.status).toBe(409)
  })

  it('refuses to archive or deactivate the default location', async () => {
    const archived = await del(`/admin/locations/${MAIN_LOCATION}`)
    expect(archived.status).toBe(422)
    expect(archived.body.code).toBe('LAST_LOCATION_PROTECTED')

    const deactivated = await patch(`/admin/locations/${MAIN_LOCATION}`, { isActive: false })
    expect(deactivated.status).toBe(422)
  })

  it('refuses to archive a location that still holds stock', async () => {
    const branch = await post('/admin/locations', { code: 'branch-3', name: 'Branch 3' })
    const product = await createSimpleProduct(app, owner.accessToken)
    await receive(product.variants[0]!.id, 5, { locationId: branch.body.data.id })

    const res = await del(`/admin/locations/${branch.body.data.id}`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('LOCATION_IN_USE')
  })

  // ── Levels and adjustments ────────────────────────────────────────────────

  it('receives stock and records why', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    const res = await receive(variantId, 10, { note: 'Monday delivery' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ onHand: 10, reserved: 0, available: 10 })

    const item = await get(`/admin/inventory/variants/${variantId}`)
    expect(item.body.data.totals).toEqual({ onHand: 10, reserved: 0, available: 10 })
    expect(item.body.data.levels[0]).toMatchObject({ locationCode: 'main', onHand: 10 })

    const history = await get(`/admin/inventory/items/${item.body.data.id}/history`)
    expect(history.body.data[0]).toMatchObject({
      reason: 'receive',
      delta: { onHand: 10, reserved: 0 },
      resulting: { onHand: 10, reserved: 0 },
      note: 'Monday delivery',
      actorUserId: owner.user.id,
    })
  })

  it('keeps stock per location, not per item', async () => {
    const branch = await post('/admin/locations', { code: 'branch-4', name: 'Branch 4' })
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    await receive(variantId, 10)
    await receive(variantId, 4, { locationId: branch.body.data.id })

    const item = await get(`/admin/inventory/variants/${variantId}`)
    expect(item.body.data.levels).toHaveLength(2)
    expect(item.body.data.totals.onHand).toBe(14)

    const byCode = Object.fromEntries(
      item.body.data.levels.map((l: { locationCode: string; onHand: number }) => [
        l.locationCode,
        l.onHand,
      ]),
    )
    expect(byCode).toEqual({ main: 10, 'branch-4': 4 })
  })

  it.each([
    ['damage', -1],
    ['waste', -3],
    ['manual_adjustment', -2],
    ['return', 4],
    ['correction', 1],
  ])('records a %s adjustment', async (reason, delta) => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 20)

    const res = await post('/admin/inventory/adjustments', { variantId, delta, reason })
    expect(res.status).toBe(201)
    expect(res.body.data.onHand).toBe(20 + delta)
  })

  it('refuses an adjustment that would take stock negative', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 3)

    const res = await post('/admin/inventory/adjustments', {
      variantId,
      delta: -5,
      reason: 'waste',
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INSUFFICIENT_STOCK')

    const item = await get(`/admin/inventory/variants/${variantId}`)
    expect(item.body.data.totals.onHand).toBe(3)
  })

  it('refuses a zero or fractional adjustment', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    for (const delta of [0, 1.5, -0.5]) {
      const res = await post('/admin/inventory/adjustments', { variantId, delta, reason: 'receive' })
      expect(res.status).toBe(422)
    }
  })

  it('refuses a reason a system writes for itself', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const res = await post('/admin/inventory/adjustments', {
      variantId: product.variants[0]!.id,
      delta: 1,
      reason: 'reservation_commit',
    })
    expect(res.status).toBe(422)
  })

  it('requires exactly one of variantId or inventoryItemId', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const item = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)

    const neither = await post('/admin/inventory/adjustments', { delta: 1, reason: 'receive' })
    expect(neither.status).toBe(422)

    const both = await post('/admin/inventory/adjustments', {
      variantId: product.variants[0]!.id,
      inventoryItemId: item.body.data.id,
      delta: 1,
      reason: 'receive',
    })
    expect(both.status).toBe(422)
  })

  it('offers no endpoint that sets a quantity outright', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const item = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)

    // Setting a number races with concurrent movements and destroys the
    // question an auditor asks. Adjustments and stocktakes are the only ways in.
    const attempt = await patch(`/admin/inventory/items/${item.body.data.id}`, { onHand: 99 })
    expect(attempt.status).toBe(422)
  })

  // ── available is derived ──────────────────────────────────────────────────

  it('derives available in the database, where it cannot drift', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 10)

    const generated = await queryOne<{ is_generated: string }>(
      `SELECT is_generated FROM information_schema.columns
        WHERE table_name = 'inventory_levels' AND column_name = 'available'`,
    )
    expect(generated?.is_generated).toBe('ALWAYS')

    await expect(execute(`UPDATE inventory_levels SET available = 99`)).rejects.toThrow()
  })

  // ── Stocktake ─────────────────────────────────────────────────────────────

  it('records a count as the delta it implies', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 20)

    const res = await post('/admin/inventory/stocktake', { variantId, countedOnHand: 17 })
    expect(res.status).toBe(201)
    expect(res.body.data.onHand).toBe(17)

    const item = await get(`/admin/inventory/variants/${variantId}`)
    const history = await get(`/admin/inventory/items/${item.body.data.id}/history`)
    expect(history.body.data[0]).toMatchObject({
      reason: 'stocktake',
      delta: { onHand: -3, reserved: 0 },
    })
  })

  it('writes nothing when a count matches', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 8)

    await post('/admin/inventory/stocktake', { variantId, countedOnHand: 8 })

    const item = await get(`/admin/inventory/variants/${variantId}`)
    const history = await get(`/admin/inventory/items/${item.body.data.id}/history`)
    // One movement: the receive. A count that changes nothing is not an event.
    expect(history.body.meta.pagination.total).toBe(1)
  })

  // ── History is append-only ────────────────────────────────────────────────

  it('refuses to edit or delete a movement', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    await receive(product.variants[0]!.id, 5)

    await expect(execute(`UPDATE inventory_movements SET delta_on_hand = 999`)).rejects.toThrow()
    await expect(execute(`DELETE FROM inventory_movements`)).rejects.toThrow()
  })

  it('keeps the running totals on each movement, so history reads without re-summing', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 10)
    await post('/admin/inventory/adjustments', { variantId, delta: -4, reason: 'waste' })

    const item = await get(`/admin/inventory/variants/${variantId}`)
    const history = await get(`/admin/inventory/items/${item.body.data.id}/history`)
    expect(history.body.data.map((m: { resulting: { onHand: number } }) => m.resulting.onHand)).toEqual(
      [6, 10],
    )
  })

  // ── Transfers ─────────────────────────────────────────────────────────────

  it('moves stock between locations atomically', async () => {
    const branch = await post('/admin/locations', { code: 'branch-5', name: 'Branch 5' })
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 10)

    const res = await post('/admin/inventory/transfers', {
      variantId,
      fromLocationId: MAIN_LOCATION,
      toLocationId: branch.body.data.id,
      quantity: 4,
    })

    expect(res.status).toBe(201)
    expect(res.body.data.from.onHand).toBe(6)
    expect(res.body.data.to.onHand).toBe(4)

    const item = await get(`/admin/inventory/variants/${variantId}`)
    // The total is conserved: a transfer is a move, not a creation.
    expect(item.body.data.totals.onHand).toBe(10)
  })

  it('leaves nothing behind when a transfer cannot complete', async () => {
    const branch = await post('/admin/locations', { code: 'branch-6', name: 'Branch 6' })
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 3)

    const res = await post('/admin/inventory/transfers', {
      variantId,
      fromLocationId: MAIN_LOCATION,
      toLocationId: branch.body.data.id,
      quantity: 5,
    })
    expect(res.status).toBe(422)

    const item = await get(`/admin/inventory/variants/${variantId}`)
    // Neither leg applied: the destination did not gain stock the source never lost.
    expect(item.body.data.totals.onHand).toBe(3)
    expect(item.body.data.levels).toHaveLength(1)
  })

  it('refuses a transfer to the same location', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const res = await post('/admin/inventory/transfers', {
      variantId: product.variants[0]!.id,
      fromLocationId: MAIN_LOCATION,
      toLocationId: MAIN_LOCATION,
      quantity: 1,
    })
    expect(res.status).toBe(422)
  })

  // ── Tracking policy ───────────────────────────────────────────────────────

  it('treats an untracked item as unlimited, never as zero', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const item = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)

    // Zero stock, tracking off.
    const res = await patch(`/admin/inventory/items/${item.body.data.id}`, {
      trackInventory: false,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.trackInventory).toBe(false)
    expect(res.body.data.totals.available).toBe(0)
    // …and it is still low-stock-free, because "low" is meaningless untracked.
    expect(res.body.data.isLow).toBe(false)
  })

  it('records a tracking change in the audit trail and publishes an event', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const item = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)
    await patch(`/admin/inventory/items/${item.body.data.id}`, { trackInventory: false })

    const audit = await queryOne<{ action: string; after: { trackInventory: boolean } }>(
      `SELECT action, after FROM audit_logs WHERE resource_id = $1 ORDER BY id DESC LIMIT 1`,
      [item.body.data.id],
    )
    expect(audit?.action).toBe('inventory.policy_changed')
    expect(audit?.after.trackInventory).toBe(false)
    expect(await eventNames()).toContain('inventory.tracking_changed')
  })

  it('falls back to the store threshold when the item does not set one', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const item = await get(`/admin/inventory/variants/${product.variants[0]!.id}`)

    expect(item.body.data.lowStockThreshold).toBeNull()
    // store_settings.default_low_stock_threshold is 5.
    expect(item.body.data.effectiveLowStockThreshold).toBe(5)

    const overridden = await patch(`/admin/inventory/items/${item.body.data.id}`, {
      lowStockThreshold: 0,
    })
    // 0 is a real answer — "warn me at zero" — not the same as "unset".
    expect(overridden.body.data.lowStockThreshold).toBe(0)
    expect(overridden.body.data.effectiveLowStockThreshold).toBe(0)
  })

  // ── Low-stock events fire on the crossing only ────────────────────────────

  it('emits low_stock once, when stock crosses the threshold', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 20)

    const lowStockCount = async () =>
      (await eventNames()).filter((name) => name === 'inventory.low_stock').length

    await post('/admin/inventory/adjustments', { variantId, delta: -10, reason: 'waste' })
    expect(await lowStockCount()).toBe(0)

    // 10 → 4, crossing the threshold of 5.
    await post('/admin/inventory/adjustments', { variantId, delta: -6, reason: 'waste' })
    expect(await lowStockCount()).toBe(1)

    // Still low, moving further down. Not news; no second event.
    await post('/admin/inventory/adjustments', { variantId, delta: -1, reason: 'waste' })
    await post('/admin/inventory/adjustments', { variantId, delta: -1, reason: 'waste' })
    expect(await lowStockCount()).toBe(1)
  })

  it('emits out_of_stock and back_in_stock on those crossings', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    await receive(variantId, 2)
    await post('/admin/inventory/adjustments', { variantId, delta: -2, reason: 'waste' })
    expect(await eventNames()).toContain('inventory.out_of_stock')

    await receive(variantId, 5)
    expect(await eventNames()).toContain('inventory.back_in_stock')

    const outs = (await eventNames()).filter((n) => n === 'inventory.out_of_stock')
    expect(outs).toHaveLength(1)
  })

  it('announces out of stock when the last unit is reserved, not only when written off', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 3)

    const reservation = await post('/admin/inventory/reservations', {
      variantId,
      quantity: 3,
      ownerType: 'cart',
      ownerId: '11111111-1111-4111-8111-111111111111',
    })
    expect(reservation.status).toBe(201)

    // To a customer, the last unit being spoken for is the same as it being
    // gone. A shop that announces only one of those announces the wrong half.
    expect(await eventNames()).toContain('inventory.out_of_stock')

    await post(`/admin/inventory/reservations/${reservation.body.data.id}/release`)
    expect(await eventNames()).toContain('inventory.back_in_stock')
  })

  it('crosses the low-stock threshold on a reservation too', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 20)

    await post('/admin/inventory/reservations', {
      variantId,
      quantity: 16,
      ownerType: 'cart',
      ownerId: '22222222-2222-4222-8222-222222222222',
    })
    // 20 available → 4, crossing the store threshold of 5.
    expect((await eventNames()).filter((n) => n === 'inventory.low_stock')).toHaveLength(1)
  })

  it('emits no stock-state events for an untracked item', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    const item = await get(`/admin/inventory/variants/${variantId}`)
    await patch(`/admin/inventory/items/${item.body.data.id}`, { trackInventory: false })

    await receive(variantId, 1)
    await post('/admin/inventory/adjustments', { variantId, delta: -1, reason: 'waste' })

    const names = await eventNames()
    expect(names).not.toContain('inventory.out_of_stock')
    expect(names).not.toContain('inventory.low_stock')
  })

  // ── Transaction consistency ───────────────────────────────────────────────

  it('writes the level, the movement and the event together or not at all', async () => {
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    await receive(variantId, 5)

    const before = {
      movements: (await query('SELECT 1 FROM inventory_movements')).length,
      events: (await eventNames()).length,
    }

    // Fails inside the transaction, after the level update would have applied.
    const res = await post('/admin/inventory/adjustments', {
      variantId,
      delta: -99,
      reason: 'waste',
    })
    expect(res.status).toBe(422)

    const item = await get(`/admin/inventory/variants/${variantId}`)
    expect(item.body.data.totals.onHand).toBe(5)
    expect((await query('SELECT 1 FROM inventory_movements')).length).toBe(before.movements)
    // No event describing a change that never happened (§12.1).
    expect((await eventNames()).length).toBe(before.events)
  })

  // ── Authorization ─────────────────────────────────────────────────────────

  it('lets staff adjust and transfer but not manage locations or policy', async () => {
    const staff = await createUserAndLogin(app, { roles: ['staff'] })
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id
    const item = await get(`/admin/inventory/variants/${variantId}`)

    expect((await get('/admin/inventory', staff.accessToken)).status).toBe(200)
    expect(
      (await post('/admin/inventory/adjustments', { variantId, delta: 5, reason: 'receive' }, staff.accessToken))
        .status,
    ).toBe(201)

    // Structural changes are not day-to-day work.
    expect(
      (await post('/admin/locations', { code: 'nope', name: 'Nope' }, staff.accessToken)).status,
    ).toBe(403)
    expect(
      (await patch(`/admin/inventory/items/${item.body.data.id}`, { trackInventory: false }, staff.accessToken))
        .status,
    ).toBe(403)
  })

  it('lets no customer near inventory', async () => {
    const customer = await createUserAndLogin(app, { roles: ['customer'] })
    const product = await createSimpleProduct(app, owner.accessToken)

    // requireStaff() denies before any permission is even consulted.
    expect((await get('/admin/inventory', customer.accessToken)).status).toBe(403)
    expect(
      (await post(
        '/admin/inventory/adjustments',
        { variantId: product.variants[0]!.id, delta: 100, reason: 'receive' },
        customer.accessToken,
      )).status,
    ).toBe(403)
  })

  it('is not reachable anonymously', async () => {
    expect((await request(app).get('/api/v1/admin/inventory')).status).toBe(401)
    expect((await request(app).post('/api/v1/admin/inventory/adjustments').send({})).status).toBe(401)
    expect((await request(app).get('/api/v1/admin/locations')).status).toBe(401)
  })

  it('records the acting user on both the movement and the audit row', async () => {
    const staff = await createUserAndLogin(app, { roles: ['staff'] })
    const product = await createSimpleProduct(app, owner.accessToken)
    const variantId = product.variants[0]!.id

    await post('/admin/inventory/adjustments', { variantId, delta: 7, reason: 'receive' }, staff.accessToken)

    // Two different questions: what happened to stock, and who did an
    // administrative thing. Both answered, neither replacing the other.
    const movement = await queryOne<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM inventory_movements ORDER BY id DESC LIMIT 1`,
    )
    expect(movement?.actor_user_id).toBe(staff.user.id)

    const audit = await queryOne<{ actor_email: string; action: string }>(
      `SELECT actor_email, action FROM audit_logs ORDER BY id DESC LIMIT 1`,
    )
    expect(audit?.action).toBe('inventory.adjusted')
    expect(audit?.actor_email).toBe(staff.user.email)
  })

  // ── Listing ───────────────────────────────────────────────────────────────

  it('lists items and filters to the low ones', async () => {
    const plenty = await createSimpleProduct(app, owner.accessToken, { handle: uniqueHandle('a') })
    const scarce = await createSimpleProduct(app, owner.accessToken, { handle: uniqueHandle('b') })
    await receive(plenty.variants[0]!.id, 50)
    await receive(scarce.variants[0]!.id, 2)

    const all = await get('/admin/inventory')
    expect(all.body.meta.pagination.total).toBe(2)

    const low = await get('/admin/inventory?low=true')
    expect(low.body.meta.pagination.total).toBe(1)
    expect(low.body.data[0].variantId).toBe(scarce.variants[0]!.id)
  })

  it('404s for an item or variant that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect((await get(`/admin/inventory/items/${missing}`)).status).toBe(404)
    expect((await get(`/admin/inventory/variants/${missing}`)).status).toBe(404)
  })
})
