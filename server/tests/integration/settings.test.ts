/**
 * Store settings (§23.14).
 *
 * Two things are being defended here. First, that the storefront's view is a
 * whitelist rather than the admin serializer with a few fields removed — the
 * difference decides whether tomorrow's admin-only setting leaks by default.
 * Second, that the in-process cache cannot serve a stale answer after a write,
 * in either process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { settingsService } from '../../src/features/settings/index.js'
import { usersService } from '../../src/features/users/index.js'
import { setStorage } from '../../src/infrastructure/storage/index.js'
import { MemoryStorageProvider } from '../../src/infrastructure/storage/providers/memory.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUserAndLogin, eventNames } from '../factories/auth.js'
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

function patch(accessToken: string, body: Record<string, unknown>) {
  return request(app)
    .patch('/api/v1/admin/settings')
    .set('Authorization', bearer(accessToken))
    .send(body)
}

describeIfDatabase('store settings', () => {
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

  it('is seeded by migration, so the first request has settings', async () => {
    const settings = await settingsService.get()
    expect(settings.storeName).toBe('My Store')
    expect(settings.currency).toBe('USD')
    expect(settings.taxRateBps).toBe(0)
  })

  // ── The public surface ────────────────────────────────────────────────────

  it('serves the public subset to anyone, with no token at all', async () => {
    const res = await request(app).get('/api/v1/storefront/settings')

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      storeName: 'My Store',
      currency: 'USD',
      timezone: 'UTC',
      guestCheckoutEnabled: true,
    })
  })

  it('withholds everything operational from the storefront', async () => {
    await patch(admin.accessToken, { taxRateBps: 2000, reservationTtlMinutes: 15 })

    const res = await request(app).get('/api/v1/storefront/settings')
    const keys = Object.keys(res.body.data)

    for (const secret of [
      'taxRateBps',
      'pricesIncludeTax',
      'defaultLowStockThreshold',
      'reservationTtlMinutes',
      'orderNumberPrefix',
      'metadata',
      'updatedBy',
      'logoMediaId',
    ]) {
      expect(keys, `${secret} must not be public`).not.toContain(secret)
    }
  })

  it('reads back every field it accepts a write for', async () => {
    // The COD policy was writable and unreadable: a settings form could save a
    // new ceiling and had no way to show the current one, so it rendered every
    // control as though the policy were off.
    await patch(admin.accessToken, {
      codEnabled: true,
      codMinSubtotalCents: 1000,
      codMaxSubtotalCents: 25_000,
      codFeeCents: 199,
      codCountryCodes: ['GB', 'IE'],
      codRequiresAccount: true,
      codMaxOpenOrders: 2,
      orderReservationHours: 48,
    })

    const res = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', bearer(admin.accessToken))

    expect(res.body.data).toMatchObject({
      codEnabled: true,
      codMinSubtotalCents: 1000,
      codMaxSubtotalCents: 25_000,
      codFeeCents: 199,
      codCountryCodes: ['GB', 'IE'],
      codRequiresAccount: true,
      codMaxOpenOrders: 2,
      orderReservationHours: 48,
    })
  })

  it('keeps the COD thresholds off the storefront', async () => {
    // What the abuse controls are set to is exactly what to stay under, so the
    // storefront learns only that COD is offered at all.
    await patch(admin.accessToken, { codEnabled: true, codMaxSubtotalCents: 25_000 })

    const res = await request(app).get('/api/v1/storefront/settings')

    expect(res.body.data.codEnabled).toBe(true)
    for (const secret of [
      'codMinSubtotalCents',
      'codMaxSubtotalCents',
      'codFeeCents',
      'codCountryCodes',
      'codMaxOpenOrders',
      'orderReservationHours',
    ]) {
      expect(Object.keys(res.body.data), `${secret} must not be public`).not.toContain(secret)
    }
  })

  // ── Writing ───────────────────────────────────────────────────────────────

  it('applies a partial update and leaves everything else alone', async () => {
    const res = await patch(admin.accessToken, { storeName: 'Copperleaf', currency: 'GBP' })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ storeName: 'Copperleaf', currency: 'GBP' })
    expect(res.body.data.timezone).toBe('UTC')
    expect(res.body.data.updatedBy).toBe(admin.user.id)
  })

  it('takes effect immediately, cache notwithstanding', async () => {
    await patch(admin.accessToken, { storeName: 'Copperleaf' })

    // Same process, no waiting for the 60s TTL.
    expect((await settingsService.get()).storeName).toBe('Copperleaf')
    const publicView = await request(app).get('/api/v1/storefront/settings')
    expect(publicView.body.data.storeName).toBe('Copperleaf')
  })

  it('publishes settings.updated so the worker process drops its own copy', async () => {
    await patch(admin.accessToken, { storeName: 'Copperleaf' })

    expect(await eventNames()).toContain('settings.updated')
    const event = await queryOne<{ payload: { changed: string[] } }>(
      `SELECT payload FROM domain_events WHERE name = 'settings.updated'`,
    )
    expect(event?.payload.changed).toEqual(['storeName'])
  })

  it('audits only what actually changed', async () => {
    await patch(admin.accessToken, { storeName: 'Copperleaf', currency: 'USD' })

    const audit = await queryOne<{
      action: string
      before: Record<string, unknown>
      after: Record<string, unknown>
      actor_email: string
    }>(`SELECT action, before, after, actor_email FROM audit_logs ORDER BY id DESC LIMIT 1`)

    expect(audit?.action).toBe('settings.updated')
    expect(audit?.before).toEqual({ storeName: 'My Store' })
    // currency was already USD, so it is not part of the change.
    expect(audit?.after).toEqual({ storeName: 'Copperleaf' })
    expect(audit?.actor_email).toBe(admin.user.email)
  })

  it('writes no audit row when a patch changes nothing', async () => {
    const res = await patch(admin.accessToken, { storeName: 'My Store' })

    expect(res.status).toBe(200)
    const count = await queryOne<{ count: number }>('SELECT count(*)::int FROM audit_logs')
    expect(count?.count).toBe(0)
  })

  it('rejects an empty patch rather than pretending to save', async () => {
    const res = await patch(admin.accessToken, {})
    expect(res.status).toBe(422)
  })

  // ── Validation ────────────────────────────────────────────────────────────

  it.each([
    ['a lowercase currency', { currency: 'gbp' }],
    ['a currency of the wrong length', { currency: 'POUNDS' }],
    ['an invented timezone', { timezone: 'Middle/Earth' }],
    ['a negative tax rate', { taxRateBps: -1 }],
    ['a tax rate over 100%', { taxRateBps: 10_001 }],
    ['a weight unit we do not use', { weightUnit: 'stone' }],
    ['a zero reservation window', { reservationTtlMinutes: 0 }],
    ['an empty store name', { storeName: '   ' }],
    ['a support URL that is not a URL', { supportUrl: 'javascript:alert(1)' }],
    ['a malformed contact address', { contactEmail: 'not-an-address' }],
  ])('refuses %s', async (_label, body) => {
    const res = await patch(admin.accessToken, body)
    expect(res.status).toBe(422)
  })

  it('accepts a real IANA timezone', async () => {
    const res = await patch(admin.accessToken, { timezone: 'Europe/London' })
    expect(res.status).toBe(200)
    expect(res.body.data.timezone).toBe('Europe/London')
  })

  it('refuses fields the caller has no business writing', async () => {
    for (const body of [{ id: 2 }, { updatedBy: admin.user.id }, { createdAt: '2020-01-01' }]) {
      const res = await patch(admin.accessToken, body)
      expect(res.status).toBe(422)
    }
  })

  // ── Authorisation ─────────────────────────────────────────────────────────

  it('needs settings:read to look and settings:write to change', async () => {
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    const read = await request(app)
      .get('/api/v1/admin/settings')
      .set('Authorization', bearer(staff.accessToken))
    expect(read.status).toBe(403)

    const write = await patch(staff.accessToken, { storeName: 'Nope' })
    expect(write.status).toBe(403)
    expect(await queryOne<{ store_name: string }>('SELECT store_name FROM store_settings')).toEqual({
      store_name: 'My Store',
    })
  })

  it('is not reachable anonymously', async () => {
    expect((await request(app).get('/api/v1/admin/settings')).status).toBe(401)
    expect((await request(app).patch('/api/v1/admin/settings').send({})).status).toBe(401)
  })

  // ── The logo ──────────────────────────────────────────────────────────────

  it('refuses a logo that has not been processed yet', async () => {
    const upload = await request(app)
      .post('/api/v1/admin/media/uploads')
      .set('Authorization', bearer(admin.accessToken))
      .send({ contentType: 'image/png', byteSize: 1024 })

    const res = await patch(admin.accessToken, { logoMediaId: upload.body.data.assetId })
    expect(res.status).toBe(422)
  })

  it('refuses a logo that does not exist', async () => {
    const res = await patch(admin.accessToken, {
      logoMediaId: '00000000-0000-4000-8000-000000000000',
    })
    expect(res.status).toBe(422)
  })

  it('exposes a ready logo to the storefront as a URL, not an id', async () => {
    const upload = await request(app)
      .post('/api/v1/admin/media/uploads')
      .set('Authorization', bearer(admin.accessToken))
      .send({ contentType: 'image/png', byteSize: 1024 })
    const assetId = upload.body.data.assetId as string

    // Stand in for the worker having finished.
    await execute(
      `UPDATE media_assets SET status = 'ready', mime_type = 'image/png', byte_size = 100,
              width = 10, height = 10 WHERE id = $1`,
      [assetId],
    )

    const patched = await patch(admin.accessToken, { logoMediaId: assetId })
    expect(patched.status).toBe(200)

    const publicView = await request(app).get('/api/v1/storefront/settings')
    expect(publicView.body.data.logoUrl).toContain(upload.body.data.storageKey)
    expect(publicView.body.data.logoMediaId).toBeUndefined()
  })

  // ── Email branding ────────────────────────────────────────────────────────

  it('supplies the branding the email layout uses', async () => {
    await patch(admin.accessToken, { storeName: 'Copperleaf', contactEmail: 'hi@copperleaf.test' })

    expect(await settingsService.getBranding()).toEqual({
      storeName: 'Copperleaf',
      supportEmail: 'hi@copperleaf.test',
    })
  })
})
