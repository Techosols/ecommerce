/**
 * Inventory under concurrency (docs/inventory.md §6).
 *
 * These are the tests the whole subsystem exists to pass. Everything else can
 * be re-derived from a schema; overselling cannot be undone, and a bug here is
 * invisible in development and constant in production.
 *
 * Every case runs real, simultaneous requests against real PostgreSQL. There is
 * no in-process mutex anywhere in the implementation — that would be worthless
 * the moment a second Node process starts — so what is under test is the
 * database's own guarantee: a conditional `UPDATE` takes the row lock as part
 * of the write, and a blocked writer re-evaluates its `WHERE` against the
 * committed new version before proceeding.
 *
 * `pool.max` is greater than one, so these requests genuinely overlap on
 * separate connections rather than queueing on a single client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { getPool } from '../../src/infrastructure/database/pool.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { reservationsService } from '../../src/features/inventory/index.js'
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

describeIfDatabase('inventory under concurrency', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken)).send(body)
  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))

  /** A stocked variant, ready to be fought over. */
  async function stocked(quantity: number): Promise<{ variantId: string; itemId: string }> {
    const product = await createSimpleProduct(app, owner.accessToken, {
      handle: uniqueHandle('contested'),
    })
    const variantId = product.variants[0]!.id
    // A zero-delta adjustment is refused by design, so an empty shelf is simply
    // an item with no movements yet.
    if (quantity > 0) {
      await post('/admin/inventory/adjustments', { variantId, delta: quantity, reason: 'receive' })
    }
    const item = await get(`/admin/inventory/variants/${variantId}`)
    return { variantId, itemId: item.body.data.id }
  }

  async function level(itemId: string) {
    return queryOne<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_levels WHERE inventory_item_id = $1`,
      [itemId],
    )
  }

  const reserve = (variantId: string, quantity: number, ownerId: string) =>
    post('/admin/inventory/reservations', {
      variantId,
      quantity,
      ownerType: 'cart',
      ownerId,
    })

  beforeAll(async () => {
    await setupDatabase()
    // Overlapping requests need overlapping connections; one would serialise
    // them and the tests would pass without proving anything.
    expect(getPool().options.max ?? 0).toBeGreaterThan(1)
  })
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── The headline case ─────────────────────────────────────────────────────

  it('stock 10: A reserves 7 and B reserves 5 — exactly one succeeds', async () => {
    const { variantId, itemId } = await stocked(10)

    const [a, b] = await Promise.all([
      reserve(variantId, 7, '11111111-1111-4111-8111-111111111111'),
      reserve(variantId, 5, '22222222-2222-4222-8222-222222222222'),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 422])

    const loser = a.status === 422 ? a : b
    expect(loser.body.code).toBe('INSUFFICIENT_STOCK')

    const final = await level(itemId)
    expect(final?.reserved).toBe(a.status === 201 ? 7 : 5)
    expect(final?.available).toBeGreaterThanOrEqual(0)
  })

  it('never lets available go negative, however many race for it', async () => {
    const { variantId, itemId } = await stocked(10)

    // Twelve requests for 3 each — 36 units chasing 10.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserve(variantId, 3, `3${i}111111-1111-4111-8111-111111111111`.slice(0, 36)),
      ),
    )

    const granted = results.filter((r) => r.status === 201)
    // 10 ÷ 3 = 3 whole reservations, and never a fourth.
    expect(granted).toHaveLength(3)
    expect(results.filter((r) => r.status === 422)).toHaveLength(9)

    const final = await level(itemId)
    expect(final).toMatchObject({ on_hand: 10, reserved: 9, available: 1 })
    expect(final!.available).toBeGreaterThanOrEqual(0)
  })

  it('lets exactly as many through as the stock allows, no more and no fewer', async () => {
    const { variantId, itemId } = await stocked(8)

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve(variantId, 1, `4${String(i).padStart(2, '0')}11111-1111-4111-8111-111111111111`.slice(0, 36)),
      ),
    )

    expect(results.filter((r) => r.status === 201)).toHaveLength(8)
    expect((await level(itemId))?.available).toBe(0)
  })

  // ── Concurrent adjustments ────────────────────────────────────────────────

  it('applies simultaneous receipts without losing one', async () => {
    const { variantId, itemId } = await stocked(0)

    await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/admin/inventory/adjustments', { variantId, delta: 5, reason: 'receive' }),
      ),
    )

    // A read-then-write would lose updates here and land somewhere below 50.
    expect((await level(itemId))?.on_hand).toBe(50)

    const movements = await query<{ count: string }>(
      `SELECT count(*) FROM inventory_movements WHERE inventory_item_id = $1`,
      [itemId],
    )
    // One movement per applied change, no more: the ledger and the level agree.
    expect(Number(movements[0]!.count)).toBe(10)
  })

  it('keeps the ledger and the level in agreement under mixed traffic', async () => {
    const { variantId, itemId } = await stocked(100)

    await Promise.all([
      ...Array.from({ length: 8 }, () =>
        post('/admin/inventory/adjustments', { variantId, delta: 5, reason: 'receive' }),
      ),
      ...Array.from({ length: 8 }, () =>
        post('/admin/inventory/adjustments', { variantId, delta: -3, reason: 'waste' }),
      ),
    ])

    const final = await level(itemId)
    // The sum of the ledger must equal the running total, exactly.
    const summed = await queryOne<{ sum: number }>(
      `SELECT coalesce(sum(delta_on_hand), 0)::int AS sum
         FROM inventory_movements WHERE inventory_item_id = $1`,
      [itemId],
    )
    expect(final?.on_hand).toBe(summed?.sum)
    expect(final?.on_hand).toBe(100 + 8 * 5 - 8 * 3)
  })

  it('refuses concurrent write-offs once they would exhaust the stock', async () => {
    const { variantId, itemId } = await stocked(10)

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        post('/admin/inventory/adjustments', { variantId, delta: -4, reason: 'waste' }),
      ),
    )

    expect(results.filter((r) => r.status === 201)).toHaveLength(2)
    expect((await level(itemId))?.on_hand).toBe(2)
  })

  // ── Release and commit races ──────────────────────────────────────────────

  it('releases a reservation exactly once, however many callers try', async () => {
    const { variantId, itemId } = await stocked(10)
    const created = await reserve(variantId, 4, '55555555-5555-4555-8555-555555555555')
    const reservationId = created.body.data.id

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(`/admin/inventory/reservations/${reservationId}/release`),
      ),
    )

    expect(results.filter((r) => r.status === 202)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(4)

    // Released once means 4 units back, not 20.
    const final = await level(itemId)
    expect(final).toMatchObject({ on_hand: 10, reserved: 0, available: 10 })
  })

  it('commits a reservation exactly once, however many callers try', async () => {
    const { variantId, itemId } = await stocked(10)
    const created = await reserve(variantId, 4, '66666666-6666-4666-8666-666666666666')
    const reservationId = created.body.data.id

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(`/admin/inventory/reservations/${reservationId}/commit`),
      ),
    )

    expect(results.filter((r) => r.status === 202)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(4)

    // Committed once: 4 units left the building, and reserved went with them.
    expect(await level(itemId)).toMatchObject({ on_hand: 6, reserved: 0, available: 6 })
  })

  it('resolves a reservation one way when release and commit race', async () => {
    const { variantId, itemId } = await stocked(10)
    const created = await reserve(variantId, 4, '77777777-7777-4777-8777-777777777777')
    const reservationId = created.body.data.id

    const [release, commit] = await Promise.all([
      post(`/admin/inventory/reservations/${reservationId}/release`),
      post(`/admin/inventory/reservations/${reservationId}/commit`),
    ])

    // One outcome, not both. Which one wins is a race; that only one does is not.
    expect([release.status, commit.status].sort()).toEqual([202, 409])

    const row = await queryOne<{ status: string }>(
      `SELECT status FROM inventory_reservations WHERE id = $1`,
      [reservationId],
    )
    expect(['released', 'committed']).toContain(row?.status)

    const final = await level(itemId)
    expect(final?.reserved).toBe(0)
    // Released → 10 back; committed → 6 remain. Never 14, never 2.
    expect([6, 10]).toContain(final?.on_hand)
  })

  it('refuses a second active reservation from the same owner', async () => {
    const { variantId } = await stocked(20)
    const ownerId = '88888888-8888-4888-8888-888888888888'

    const results = await Promise.all([
      reserve(variantId, 2, ownerId),
      reserve(variantId, 2, ownerId),
    ])

    // A retried checkout request must not silently hold twice the stock.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(1)
  })

  // ── Reservations vs adjustments ───────────────────────────────────────────

  it('will not let stock be written off from under a live reservation', async () => {
    const { variantId, itemId } = await stocked(10)
    await reserve(variantId, 8, '99999999-9999-4999-8999-999999999999')

    // 2 unreserved. Removing 5 would strand the reservation.
    const res = await post('/admin/inventory/adjustments', {
      variantId,
      delta: -5,
      reason: 'waste',
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INSUFFICIENT_STOCK')

    expect(await level(itemId)).toMatchObject({ on_hand: 10, reserved: 8, available: 2 })
  })

  it('holds the invariant when a reservation and a write-off race', async () => {
    const { variantId, itemId } = await stocked(10)

    await Promise.all([
      reserve(variantId, 6, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      post('/admin/inventory/adjustments', { variantId, delta: -6, reason: 'waste' }),
    ])

    const final = await level(itemId)
    // Whatever order they landed in, reserved never exceeds on_hand.
    expect(final!.reserved).toBeLessThanOrEqual(final!.on_hand)
    expect(final!.available).toBeGreaterThanOrEqual(0)
  })

  // ── The expiry sweep ──────────────────────────────────────────────────────

  it('expires a reservation once, even with two sweeps running', async () => {
    const { variantId, itemId } = await stocked(10)
    const created = await reserve(variantId, 4, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    await query(`UPDATE inventory_reservations SET expires_at = now() - interval '1 minute'`)

    const [first, second] = await Promise.all([
      reservationsService.expireDue(50),
      reservationsService.expireDue(50),
    ])

    // Two workers, one expiry. The compare-and-swap decides.
    expect(first + second).toBe(1)
    expect(await level(itemId)).toMatchObject({ on_hand: 10, reserved: 0, available: 10 })

    const row = await queryOne<{ status: string }>(
      `SELECT status FROM inventory_reservations WHERE id = $1`,
      [created.body.data.id],
    )
    expect(row?.status).toBe('expired')
  })

  it('does not expire a reservation that was already committed', async () => {
    const { variantId, itemId } = await stocked(10)
    const created = await reserve(variantId, 4, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    await post(`/admin/inventory/reservations/${created.body.data.id}/commit`)

    await query(`UPDATE inventory_reservations SET expires_at = now() - interval '1 minute'`)
    expect(await reservationsService.expireDue(50)).toBe(0)

    // The commit stands: 4 left, and expiry did not hand them back.
    expect(await level(itemId)).toMatchObject({ on_hand: 6, reserved: 0 })
  })
})
