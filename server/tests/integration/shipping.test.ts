/**
 * Shipping zones, rates and the rate card (§5.8, CLAUDE.md §19).
 *
 * The three things this suite exists to hold down:
 *
 *   **The server quotes the price.** A shopper asks "what does delivery cost to
 *   GB, for this basket, at this weight?" and is answered with methods and
 *   amounts the server computed. No price crosses the boundary inbound, so a
 *   stale quote in a browser tab can never become a cheap delivery.
 *
 *   **A quote is not the rate card.** The public endpoint returns what applies
 *   to *one* destination and nothing else — never the zones, never which
 *   countries they cover, never the weight bands. Those are the store's
 *   commercial arrangements, and a competitor should have to guess.
 *
 *   **Methods are archived, never deleted.** Past orders name the method they
 *   were shipped by. Deleting the row would leave those orders citing nothing,
 *   so a DELETE must retire the method from every listing and every quote while
 *   leaving the row where it is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
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

interface Rate {
  id: string
  name: string
  description: string | null
  price: { amount: number; currency: string }
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

describeIfDatabase('shipping', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  /**
   * The factory in `tests/factories/commerce.ts` makes a zone and a method in
   * one go, which is exactly wrong here: this suite needs to vary the two
   * independently — a zone with two methods, a method with a weight band — so
   * it drives the same admin endpoints itself.
   */
  const createZone = async (body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/admin/shipping/zones')
      .set('Authorization', bearer(owner.accessToken))
      .send({ name: 'United Kingdom', countryCodes: ['GB'], ...body })

  const createMethod = async (zoneId: string, body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/admin/shipping/methods')
      .set('Authorization', bearer(owner.accessToken))
      .send({ zoneId, name: 'Standard', rateType: 'flat', priceCents: 499, ...body })

  const listMethods = async (zoneId?: string) =>
    request(app)
      .get(`/api/v1/admin/shipping/methods${zoneId ? `?zoneId=${zoneId}` : ''}`)
      .set('Authorization', bearer(owner.accessToken))

  /** The public quote. Deliberately unauthenticated — a shopper has no account yet. */
  const quote = async (
    params: { countryCode?: string; subtotalCents?: number; weightGrams?: number } = {},
  ) => {
    const query = new URLSearchParams({
      countryCode: params.countryCode ?? 'GB',
      subtotalCents: String(params.subtotalCents ?? 0),
      weightGrams: String(params.weightGrams ?? 0),
    })
    return request(app).get(`/api/v1/storefront/shipping/rates?${query.toString()}`)
  }

  /** A GB zone with one flat method — the shape most of these tests start from. */
  const gbZoneWithMethod = async (method: Record<string, unknown> = {}) => {
    const zone = await createZone()
    const created = await createMethod(zone.body.data.id as string, method)
    expect(created.status).toBe(201)
    return { zoneId: zone.body.data.id as string, methodId: created.body.data.id as string }
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

  // ── Rating ────────────────────────────────────────────────────────────────

  describe('what delivery costs', () => {
    it('quotes the methods that will actually deliver to the destination', async () => {
      const { methodId } = await gbZoneWithMethod({ estimatedDaysMin: 2, estimatedDaysMax: 4 })

      const res = await quote({ countryCode: 'GB', subtotalCents: 1000, weightGrams: 500 })

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({
        id: methodId,
        name: 'Standard',
        price: { amount: 499, currency: 'USD' },
        estimatedDaysMin: 2,
        estimatedDaysMax: 4,
      })
    })

    it('answers a destination nobody covers with an empty list, not an error', async () => {
      // An empty list is a fact about the store, not a failure of the request.
      // A 404 here would make every storefront treat "we do not ship to Japan"
      // as a broken page, and checkout is where the refusal belongs.
      await gbZoneWithMethod()

      const res = await quote({ countryCode: 'JP' })

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('ignores a zone that has been switched off', async () => {
      const { zoneId } = await gbZoneWithMethod()
      await execute(`UPDATE shipping_zones SET is_active = false WHERE id = $1`, [zoneId])

      expect((await quote({ countryCode: 'GB' })).body.data).toEqual([])
    })

    it('drops the charge to nothing once the basket passes the free-delivery threshold', async () => {
      await gbZoneWithMethod({ priceCents: 499, freeOverSubtotalCents: 5000 })

      const below = await quote({ subtotalCents: 4999 })
      const at = await quote({ subtotalCents: 5000 })

      // The threshold is inclusive: "free over £50" advertised on the banner and
      // a £50 basket still paying postage is the complaint this pins down.
      expect(below.body.data[0].price.amount).toBe(499)
      expect(at.body.data[0].price.amount).toBe(0)
    })

    it('charges nothing for a free method whatever the basket is worth', async () => {
      // The price column is ignored rather than trusted: a method typed `free`
      // that still had a price left on it from an earlier edit would otherwise
      // charge for collection.
      await gbZoneWithMethod({ rateType: 'free', priceCents: 999 })

      expect((await quote({ subtotalCents: 0 })).body.data[0].price.amount).toBe(0)
      expect((await quote({ subtotalCents: 100_000 })).body.data[0].price.amount).toBe(0)
    })

    it('withholds a method when the parcel is too light for its band', async () => {
      await gbZoneWithMethod({ name: 'Heavy goods', minWeightGrams: 1000, maxWeightGrams: 20_000 })

      expect((await quote({ weightGrams: 999 })).body.data).toEqual([])
      expect((await quote({ weightGrams: 1000 })).body.data).toHaveLength(1)
    })

    it('withholds a method when the parcel is too heavy for its band', async () => {
      // The carrier will refuse the parcel at the counter; quoting it anyway
      // sells a delivery the store cannot buy.
      await gbZoneWithMethod({ name: 'Letter post', maxWeightGrams: 2000 })

      expect((await quote({ weightGrams: 2000 })).body.data).toHaveLength(1)
      expect((await quote({ weightGrams: 2001 })).body.data).toEqual([])
    })

    it('offers every method the destination and the parcel qualify for', async () => {
      const zone = await createZone({ countryCodes: ['GB', 'IE'] })
      await createMethod(zone.body.data.id as string, { name: 'Standard', priceCents: 499, position: 1 })
      await createMethod(zone.body.data.id as string, { name: 'Express', priceCents: 1299, position: 2 })

      const res = await quote({ countryCode: 'IE', weightGrams: 500 })

      expect(res.body.data.map((rate: Rate) => rate.name)).toEqual(['Standard', 'Express'])
    })
  })

  // ── What a quote does not say ─────────────────────────────────────────────

  describe('the quote is not the rate card', () => {
    it('never discloses the zone, the countries it covers or the weight band', async () => {
      await gbZoneWithMethod({
        minWeightGrams: 0,
        maxWeightGrams: 30_000,
        freeOverSubtotalCents: 5000,
      })

      const res = await quote({ subtotalCents: 100, weightGrams: 500 })
      const rate = res.body.data[0] as Record<string, unknown>

      // Serialised by hand on the public route, so this list is the contract.
      // Anything new that appears here has leaked out of the admin DTO.
      expect(Object.keys(rate).sort()).toEqual([
        'description',
        'estimatedDaysMax',
        'estimatedDaysMin',
        'id',
        'name',
        'price',
      ])
      for (const hidden of [
        'zoneId',
        'countryCodes',
        'minWeightGrams',
        'maxWeightGrams',
        'freeOverSubtotalCents',
        'priceCents',
        'rateType',
        'isActive',
        'position',
      ]) {
        expect(rate).not.toHaveProperty(hidden)
      }
    })

    it('has no public route that lists the zones at all', async () => {
      await gbZoneWithMethod()

      const res = await request(app).get('/api/v1/storefront/shipping/zones')

      expect(res.status).toBe(404)
    })
  })

  // ── The rate card ─────────────────────────────────────────────────────────

  // ── The zone lifecycle ────────────────────────────────────────────────────

  describe('changing and retiring a zone', () => {
    const patchZone = async (id: string, body: Record<string, unknown>) =>
      request(app)
        .patch(`/api/v1/admin/shipping/zones/${id}`)
        .set('Authorization', bearer(owner.accessToken))
        .send(body)

    const archiveZone = async (id: string) =>
      request(app)
        .delete(`/api/v1/admin/shipping/zones/${id}`)
        .set('Authorization', bearer(owner.accessToken))

    const listZones = async (query = '') =>
      request(app)
        .get(`/api/v1/admin/shipping/zones${query}`)
        .set('Authorization', bearer(owner.accessToken))

    it('renames a zone and re-covers it, and the quote follows', async () => {
      const { zoneId } = await gbZoneWithMethod()

      const res = await patchZone(zoneId, { name: 'Britain and Ireland', countryCodes: ['GB', 'IE'] })

      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        name: 'Britain and Ireland',
        countryCodes: ['GB', 'IE'],
      })
      // The point of the edit: Ireland can now be quoted.
      expect((await quote({ countryCode: 'IE' })).body.data).toHaveLength(1)
    })

    it('refuses to leave a country covered by two live zones', async () => {
      await createZone({ name: 'United Kingdom', countryCodes: ['GB'] })

      const clash = await createZone({ name: 'Europe', countryCodes: ['FR', 'GB'] })

      expect(clash.status).toBe(422)
      expect(clash.body.code).toBe('DOMAIN_RULE_VIOLATION')
      // Names both halves, because "there is a conflict" is not actionable.
      expect(clash.body.message).toMatch(/GB/)
      expect(clash.body.message).toMatch(/United Kingdom/)
    })

    it('refuses the same overlap when it arrives by an edit rather than a create', async () => {
      await createZone({ name: 'United Kingdom', countryCodes: ['GB'] })
      const europe = await createZone({ name: 'Europe', countryCodes: ['FR'] })

      const res = await patchZone(europe.body.data.id as string, { countryCodes: ['FR', 'GB'] })

      expect(res.status).toBe(422)
      // And the zone is untouched, not half-applied.
      expect((await listZones()).body.data.find((z: { name: string }) => z.name === 'Europe'))
        .toMatchObject({ countryCodes: ['FR'] })
    })

    it('does not count a switched-off zone as covering anything', async () => {
      const gb = await createZone({ name: 'United Kingdom', countryCodes: ['GB'] })
      await patchZone(gb.body.data.id as string, { isActive: false })

      // The country is free again: an inactive zone quotes nobody, so it cannot
      // be the reason a live one is refused.
      expect((await createZone({ name: 'Britain', countryCodes: ['GB'] })).status).toBe(201)
    })

    it('refuses to switch a zone back on into an overlap it would create', async () => {
      const gb = await createZone({ name: 'United Kingdom', countryCodes: ['GB'] })
      await patchZone(gb.body.data.id as string, { isActive: false })
      await createZone({ name: 'Britain', countryCodes: ['GB'] })

      const res = await patchZone(gb.body.data.id as string, { isActive: true })

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/Britain/)
    })

    it('archives a zone without destroying the methods orders were priced by', async () => {
      const { zoneId, methodId } = await gbZoneWithMethod()

      expect((await archiveZone(zoneId)).status).toBe(204)

      // Gone from the rate card and from every quote…
      expect((await listZones()).body.data).toHaveLength(0)
      expect((await quote({ countryCode: 'GB' })).body.data).toEqual([])
      // …and still on the record, which is what an order citing it needs.
      const method = await queryOne<{ id: string }>(
        `SELECT id FROM shipping_methods WHERE id = $1`,
        [methodId],
      )
      expect(method?.id).toBe(methodId)
    })

    it('shows archived zones only when asked for them', async () => {
      const { zoneId } = await gbZoneWithMethod()
      await archiveZone(zoneId)

      const withArchived = await listZones('?includeArchived=true')

      expect(withArchived.body.data).toHaveLength(1)
      expect(withArchived.body.data[0]).toMatchObject({ isArchived: true })
    })

    it('will not edit an archived zone in place', async () => {
      const { zoneId } = await gbZoneWithMethod()
      await archiveZone(zoneId)

      const res = await patchZone(zoneId, { name: 'Renamed' })

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/Restore it/)
    })

    it('restores a zone, and refuses if its countries were taken meanwhile', async () => {
      const { zoneId } = await gbZoneWithMethod()
      await archiveZone(zoneId)
      const replacement = await createZone({ name: 'Britain', countryCodes: ['GB'] })

      const blocked = await request(app)
        .post(`/api/v1/admin/shipping/zones/${zoneId}/restore`)
        .set('Authorization', bearer(owner.accessToken))
      expect(blocked.status).toBe(422)

      // With the claim released, the same restore succeeds.
      await archiveZone(replacement.body.data.id as string)
      const restored = await request(app)
        .post(`/api/v1/admin/shipping/zones/${zoneId}/restore`)
        .set('Authorization', bearer(owner.accessToken))

      expect(restored.status).toBe(200)
      expect(restored.body.data.isArchived).toBe(false)
      expect((await quote({ countryCode: 'GB' })).body.data).toHaveLength(1)
    })

    it('answers 404 for a zone that never existed', async () => {
      const missing = '01890000-0000-7000-8000-000000000000'
      expect((await patchZone(missing, { name: 'x' })).status).toBe(404)
      expect((await archiveZone(missing)).status).toBe(404)
    })
  })

  describe('configuring zones and methods', () => {
    it('records a zone with its country codes in upper case', async () => {
      const res = await createZone({ name: 'Ireland', countryCodes: ['IE', 'IE'] })

      expect(res.status).toBe(201)
      // De-duplicated, because a zone listing IE twice would match twice and
      // quote the same method twice.
      expect(res.body.data).toMatchObject({ name: 'Ireland', countryCodes: ['IE'] })
      expect(res.headers.location).toBe(`/api/v1/admin/shipping/zones/${res.body.data.id}`)
    })

    it('records a method against its zone with the price staff set', async () => {
      const zone = await createZone()

      const res = await createMethod(zone.body.data.id as string, {
        name: 'Express',
        priceCents: 1299,
        description: 'Next working day',
      })

      expect(res.status).toBe(201)
      expect(res.body.data).toMatchObject({
        zoneId: zone.body.data.id,
        name: 'Express',
        rateType: 'flat',
        priceCents: 1299,
        description: 'Next working day',
        isActive: true,
      })
    })

    it('lists the methods, and narrows to one zone when asked', async () => {
      const gb = await createZone({ name: 'GB', countryCodes: ['GB'] })
      const fr = await createZone({ name: 'FR', countryCodes: ['FR'] })
      await createMethod(gb.body.data.id as string, { name: 'Royal Mail' })
      await createMethod(fr.body.data.id as string, { name: 'Colissimo' })

      const all = await listMethods()
      const french = await listMethods(fr.body.data.id as string)

      expect(all.body.data).toHaveLength(2)
      expect(french.body.data.map((m: { name: string }) => m.name)).toEqual(['Colissimo'])
    })

    it('applies a price change to the next quote, not just to the record', async () => {
      // Editing the rate card and finding the storefront still quoting the old
      // number is the failure worth catching, so the assertion is on the quote.
      const { methodId } = await gbZoneWithMethod({ priceCents: 499 })

      const patched = await request(app)
        .patch(`/api/v1/admin/shipping/methods/${methodId}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ priceCents: 750, name: 'Standard (revised)' })

      expect(patched.status).toBe(200)
      expect(patched.body.data).toMatchObject({ priceCents: 750, name: 'Standard (revised)' })
      expect((await quote()).body.data[0]).toMatchObject({
        name: 'Standard (revised)',
        price: { amount: 750, currency: 'USD' },
      })
    })

    it('stops quoting a method that has been deactivated', async () => {
      const { methodId } = await gbZoneWithMethod()

      await request(app)
        .patch(`/api/v1/admin/shipping/methods/${methodId}`)
        .set('Authorization', bearer(owner.accessToken))
        .send({ isActive: false })

      expect((await quote()).body.data).toEqual([])
      // Still on the rate card, though — deactivating is not retiring.
      expect((await listMethods()).body.data).toHaveLength(1)
    })

    it('archives a deleted method rather than destroying the row', async () => {
      // Past orders name the method they were shipped by. Deleting the row
      // would leave those orders citing nothing, so DELETE retires it.
      const { methodId } = await gbZoneWithMethod()

      const res = await request(app)
        .delete(`/api/v1/admin/shipping/methods/${methodId}`)
        .set('Authorization', bearer(owner.accessToken))
      expect(res.status).toBe(204)

      const row = await queryOne<{ id: string; archived_at: Date | null; is_active: boolean }>(
        `SELECT id, archived_at, is_active FROM shipping_methods WHERE id = $1`,
        [methodId],
      )
      expect(row?.id).toBe(methodId)
      expect(row?.archived_at).not.toBeNull()
      expect(row?.is_active).toBe(false)

      // Gone from the rate card and gone from every quote.
      expect((await listMethods()).body.data).toEqual([])
      expect((await quote()).body.data).toEqual([])
    })
  })

  // ── Who may change it ─────────────────────────────────────────────────────

  describe('who may change the rate card', () => {
    it('keeps a customer out of the shipping configuration entirely', async () => {
      // The admin surface denies by default before any per-route permission is
      // consulted, so a shopper is refused for not being staff at all.
      const customer = await createUserAndLogin(app)

      const read = await request(app)
        .get('/api/v1/admin/shipping/methods')
        .set('Authorization', bearer(customer.accessToken))
      const write = await request(app)
        .post('/api/v1/admin/shipping/zones')
        .set('Authorization', bearer(customer.accessToken))
        .send({ name: 'Mine', countryCodes: ['GB'] })

      expect(read.status).toBe(403)
      expect(read.body.code).toBe('FORBIDDEN')
      expect(write.status).toBe(403)
    })

    it('demands a token: an anonymous caller is unauthenticated, not forbidden', async () => {
      // 401 rather than 403: nothing has been decided about permissions yet,
      // and a client that conflates the two retries a login it does not need.
      const res = await request(app).get('/api/v1/admin/shipping/methods')

      expect(res.status).toBe(401)
    })

    it('lets staff configure delivery, because dispatch is their daily work', async () => {
      // The contrast with discounts, where staff deliberately hold nothing:
      // shipping:write is a day-to-day operational permission (§6.5).
      const staff = await createUserAndLogin(app, { roles: ['staff'] })

      const zone = await request(app)
        .post('/api/v1/admin/shipping/zones')
        .set('Authorization', bearer(staff.accessToken))
        .send({ name: 'Staff zone', countryCodes: ['GB'] })

      expect(zone.status).toBe(201)
    })
  })

  // ── Validation ────────────────────────────────────────────────────────────

  describe('what the schema refuses', () => {
    it('refuses a weight band that excludes every parcel', async () => {
      // min above max matches nothing, so the method would be invisible with no
      // error anywhere — a rate card that silently does not work.
      const zone = await createZone()

      const res = await createMethod(zone.body.data.id as string, {
        minWeightGrams: 5000,
        maxWeightGrams: 1000,
      })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.details)).toMatch(/minWeightGrams/)
    })

    it('refuses an unknown field rather than dropping it silently', async () => {
      // A dropped key leaves the caller believing they set something. Strict
      // schemas are also what closes mass assignment (§16.3).
      const zone = await createZone()

      const res = await createMethod(zone.body.data.id as string, { archivedAt: null })

      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body.details)).toMatch(/archivedAt/)
    })

    it('refuses a rate type the rating code cannot price', async () => {
      const zone = await createZone()

      const res = await createMethod(zone.body.data.id as string, { rateType: 'negotiated' })

      expect(res.status).toBe(422)
    })

    it('refuses a quote for something that is not a country code', async () => {
      const res = await request(app).get(
        '/api/v1/storefront/shipping/rates?countryCode=GBR&weightGrams=0',
      )

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })
})
