/**
 * Notifications (§5.11, CLAUDE.md §27).
 *
 * Three things this suite exists to hold down:
 *
 *   **A notification belongs to exactly one person.** Every route here is
 *   scoped by the Actor's id from the verified token, never by an id in the
 *   URL. Reading somebody else's inbox is not merely refused — the API must not
 *   even confirm that their notification exists.
 *
 *   **A redelivered event produces one notification, not two.** Outbox dispatch
 *   is at-least-once, so `dedupeKey` and the unique index behind it are the
 *   whole defence against a customer seeing "your order shipped" three times.
 *
 *   **An absent preference row means enabled.** Preferences are opt-outs. If an
 *   absent row meant "off", every new notification type would need a backfill
 *   before anyone heard about it — and the first release after adding one would
 *   silently notify nobody.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { notificationsService } from '../../src/features/notifications/index.js'
import { usersService } from '../../src/features/users/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { bearer, createUser, createUserAndLogin } from '../factories/auth.js'
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

describeIfDatabase('notifications', () => {
  let customer: Awaited<ReturnType<typeof createUserAndLogin>>
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  /**
   * Raises a notification the way the real system does — through the service,
   * from a subscriber's point of view. There is deliberately no endpoint that
   * creates one, so a test that seeded a row by INSERT would be testing a shape
   * the application never writes.
   */
  const raise = (userId: string, overrides: Record<string, unknown> = {}) =>
    notificationsService.notify({
      userId,
      audience: 'customer',
      type: 'order.shipped',
      title: 'Your order is on its way',
      body: 'Order #1001 has shipped.',
      ...overrides,
    } as Parameters<typeof notificationsService.notify>[0])

  const mine = (path: string, token = customer.accessToken) =>
    request(app).get(`/api/v1/storefront${path}`).set('Authorization', bearer(token))

  const countRows = async (userId: string): Promise<number> => {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications WHERE user_id = $1`,
      [userId],
    )
    return row?.count ?? 0
  }

  beforeAll(setupDatabase)
  beforeEach(async () => {
    customer = await createUserAndLogin(app)
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Reading your own inbox ────────────────────────────────────────────────

  describe('listing', () => {
    it('returns only the caller’s own notifications', async () => {
      const stranger = await createUser()
      await raise(customer.user.id, { title: 'Mine' })
      await raise(stranger.id, { title: 'Theirs' })

      const res = await mine('/notifications')

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].title).toBe('Mine')
    })

    it('puts the newest notification first', async () => {
      // A notification feed read oldest-first shows a customer the thing that
      // happened last week above the thing that happened a minute ago.
      await raise(customer.user.id, { title: 'First' })
      await raise(customer.user.id, { title: 'Second' })
      await raise(customer.user.id, { title: 'Third' })

      const res = await mine('/notifications')

      expect(res.body.data.map((n: { title: string }) => n.title)).toEqual([
        'Third',
        'Second',
        'First',
      ])
    })

    it('pages through the list and reports the total', async () => {
      for (let i = 1; i <= 5; i += 1) await raise(customer.user.id, { title: `N${i}` })

      const first = await mine('/notifications?page=1&limit=2')
      const second = await mine('/notifications?page=2&limit=2')

      expect(first.body.data.map((n: { title: string }) => n.title)).toEqual(['N5', 'N4'])
      expect(second.body.data.map((n: { title: string }) => n.title)).toEqual(['N3', 'N2'])
      // The total counts the whole inbox, not the page: a badge built from
      // `data.length` would stop growing at the page size.
      expect(first.body.meta.pagination).toMatchObject({
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      })
    })

    it('serialises whether each notification has been read', async () => {
      const notification = await raise(customer.user.id)
      await notificationsService.markRead(customer.user.id, notification!.id)

      const res = await mine('/notifications')

      expect(res.body.data[0]).toMatchObject({ read: true })
      expect(res.body.data[0].readAt).toEqual(expect.any(String))
    })

    it('narrows to the unread ones when asked', async () => {
      const read = await raise(customer.user.id, { title: 'Already seen' })
      await raise(customer.user.id, { title: 'Still waiting' })
      await notificationsService.markRead(customer.user.id, read!.id)

      const res = await mine('/notifications?unread=true')

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].title).toBe('Still waiting')
      // The total narrows with the filter, or a badge driven off it would keep
      // counting notifications the customer has already dealt with.
      expect(res.body.meta.pagination.total).toBe(1)
    })

    it('counts the unread ones without fetching a page of them', async () => {
      const read = await raise(customer.user.id)
      await raise(customer.user.id)
      await raise(customer.user.id)
      await notificationsService.markRead(customer.user.id, read!.id)

      const res = await mine('/notifications/unread-count')

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ count: 2 })
    })

    it('counts nobody else’s unread notifications towards your badge', async () => {
      const stranger = await createUser()
      await raise(stranger.id)

      const res = await mine('/notifications/unread-count')
      expect(res.body.data.count).toBe(0)
    })
  })

  // ── Marking read ──────────────────────────────────────────────────────────

  describe('marking read', () => {
    it('marks one notification read', async () => {
      const notification = await raise(customer.user.id)

      const res = await request(app)
        .post(`/api/v1/storefront/notifications/${notification!.id}/read`)
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(204)
      const after = await mine('/notifications')
      expect(after.body.data[0].read).toBe(true)
    })

    it('answers 404 when the notification belongs to somebody else', async () => {
      // 404 rather than 403: the route must not confirm the id exists. A 403
      // here would turn the endpoint into an oracle for guessing valid ids.
      const stranger = await createUser()
      const theirs = await raise(stranger.id)

      const res = await request(app)
        .post(`/api/v1/storefront/notifications/${theirs!.id}/read`)
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(404)
      // And it really was left alone.
      const row = await queryOne<{ read_at: Date | null }>(
        `SELECT read_at FROM notifications WHERE id = $1`,
        [theirs!.id],
      )
      expect(row?.read_at).toBeNull()
    })

    it('answers 404 for an id that does not exist at all', async () => {
      // The same answer as somebody else's, which is the point: the two cases
      // must be indistinguishable from outside.
      const res = await request(app)
        .post('/api/v1/storefront/notifications/00000000-0000-4000-8000-000000000999/read')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(404)
    })

    it('marks everything read and says how many that was', async () => {
      const already = await raise(customer.user.id)
      await raise(customer.user.id)
      await raise(customer.user.id)
      await notificationsService.markRead(customer.user.id, already!.id)

      const res = await request(app)
        .post('/api/v1/storefront/notifications/read-all')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(200)
      // Two, not three: the one already read is not marked again, so the number
      // is honest about what actually changed.
      expect(res.body.data).toEqual({ marked: 2 })
      expect((await mine('/notifications/unread-count')).body.data.count).toBe(0)
    })

    it('leaves other people’s notifications unread when you clear yours', async () => {
      const stranger = await createUser()
      await raise(stranger.id)
      await raise(customer.user.id)

      const res = await request(app)
        .post('/api/v1/storefront/notifications/read-all')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.body.data.marked).toBe(1)
      const row = await queryOne<{ read_at: Date | null }>(
        `SELECT read_at FROM notifications WHERE user_id = $1`,
        [stranger.id],
      )
      expect(row?.read_at).toBeNull()
    })
  })

  // ── Preferences ───────────────────────────────────────────────────────────

  describe('preferences', () => {
    it('treats an absent preference row as enabled', async () => {
      // The load-bearing default. If an absent row meant "off", adding a new
      // notification type would silently notify nobody until a backfill ran.
      const row = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM notification_preferences WHERE user_id = $1`,
        [customer.user.id],
      )
      expect(row?.count).toBe(0)

      await expect(
        notificationsService.allows(customer.user.id, 'order.shipped', 'email'),
      ).resolves.toBe(true)
    })

    it('records an opt-out', async () => {
      const res = await request(app)
        .put('/api/v1/storefront/notifications/preferences')
        .set('Authorization', bearer(customer.accessToken))
        .send({ type: 'order.shipped', channel: 'email', enabled: false })

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ type: 'order.shipped', channel: 'email', enabled: false })
      await expect(
        notificationsService.allows(customer.user.id, 'order.shipped', 'email'),
      ).resolves.toBe(false)
    })

    it('opts out of one channel without touching the others', async () => {
      // A customer who does not want the email still wants the badge.
      await request(app)
        .put('/api/v1/storefront/notifications/preferences')
        .set('Authorization', bearer(customer.accessToken))
        .send({ type: 'order.shipped', channel: 'email', enabled: false })

      await expect(
        notificationsService.allows(customer.user.id, 'order.shipped', 'in_app'),
      ).resolves.toBe(true)
    })

    it('overwrites a preference rather than accumulating rows', async () => {
      const put = (enabled: boolean) =>
        request(app)
          .put('/api/v1/storefront/notifications/preferences')
          .set('Authorization', bearer(customer.accessToken))
          .send({ type: 'order.shipped', channel: 'email', enabled })

      await put(false)
      await put(true)

      const rows = await notificationsService.listPreferences(customer.user.id)
      expect(rows).toEqual([{ type: 'order.shipped', channel: 'email', enabled: true }])
    })

    it('lists only the exceptions a person has set, not an exhaustive matrix', async () => {
      // A matrix would have to be backfilled for every user each time a type is
      // added; the exceptions list needs no migration at all.
      await request(app)
        .put('/api/v1/storefront/notifications/preferences')
        .set('Authorization', bearer(customer.accessToken))
        .send({ type: 'order.shipped', channel: 'email', enabled: false })

      const res = await mine('/notifications/preferences')

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([
        { type: 'order.shipped', channel: 'email', enabled: false },
      ])
    })

    it('keeps each person’s preferences to themselves', async () => {
      await notificationsService.setPreference(owner.user.id, 'order.shipped', 'email', false)

      const res = await mine('/notifications/preferences')
      expect(res.body.data).toEqual([])
    })

    it('refuses a channel the system does not have', async () => {
      const res = await request(app)
        .put('/api/v1/storefront/notifications/preferences')
        .set('Authorization', bearer(customer.accessToken))
        .send({ type: 'order.shipped', channel: 'carrier_pigeon', enabled: false })

      expect(res.status).toBe(422)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })

  // ── Duplicate delivery ────────────────────────────────────────────────────

  describe('deduplication', () => {
    it('counts a redelivered event once', async () => {
      // Outbox dispatch is at-least-once (§8.3). The second call is the same
      // fact arriving twice, and the customer must see one badge, not two.
      const first = await raise(customer.user.id, { dedupeKey: 'order:1001:shipped' })
      const second = await raise(customer.user.id, { dedupeKey: 'order:1001:shipped' })

      expect(first).toBeDefined()
      // The duplicate reports nothing created, which is also what stops a
      // second socket push going out to a connected browser.
      expect(second).toBeUndefined()
      expect(await countRows(customer.user.id)).toBe(1)
    })

    it('creates a row per call when there is no dedupe key', async () => {
      // Two genuinely separate facts — a customer can be messaged twice about
      // the same order — so the absence of a key must not collapse them.
      await raise(customer.user.id)
      await raise(customer.user.id)

      expect(await countRows(customer.user.id)).toBe(2)
    })

    it('does not let one person’s dedupe key swallow another person’s notification', async () => {
      // The unique index is global, so a key that is not per-recipient would
      // mean the second staff member never hears about the order at all.
      const stranger = await createUser()
      await raise(customer.user.id, { dedupeKey: 'order:1001:shipped:a' })
      await raise(stranger.id, { dedupeKey: 'order:1001:shipped:b' })

      expect(await countRows(customer.user.id)).toBe(1)
      expect(await countRows(stranger.id)).toBe(1)
    })
  })

  // ── Staff fan-out ─────────────────────────────────────────────────────────

  describe('notifying staff', () => {
    it('reaches every active staff member and no customer', async () => {
      const staff = await createUser({ roles: ['staff'] })
      const admin = await createUser({ roles: ['admin'] })
      const shopper = await createUser({ roles: ['customer'] })

      await notificationsService.notifyStaff({
        type: 'inventory.low_stock',
        title: 'Low stock',
        body: 'Classic Burger is running out.',
      })

      const rows = await query<{ user_id: string; audience: string }>(
        `SELECT user_id, audience FROM notifications`,
      )
      // owner comes from beforeEach; staff and admin are staff roles too.
      expect(new Set(rows.map((r) => r.user_id))).toEqual(
        new Set([owner.user.id, staff.id, admin.id]),
      )
      expect(rows.every((r) => r.audience === 'staff')).toBe(true)
      expect(rows.some((r) => r.user_id === shopper.id)).toBe(false)
      expect(rows.some((r) => r.user_id === customer.user.id)).toBe(false)
    })

    it('skips a staff member whose account is no longer active', async () => {
      // A disabled account is somebody who has left. Notifying them is an
      // unread badge nobody will ever clear.
      const gone = await createUser({ roles: ['staff'], status: 'disabled' })

      await notificationsService.notifyStaff({
        type: 'inventory.low_stock',
        title: 'Low stock',
        body: 'Classic Burger is running out.',
      })

      expect(await countRows(gone.id)).toBe(0)
      expect(await countRows(owner.user.id)).toBe(1)
    })

    it('dedupes per recipient, so one member’s delivery does not suppress another’s', async () => {
      // The bug this holds down: a single shared dedupe key means the first
      // staff member gets the alert and everyone else silently gets nothing.
      const staff = await createUser({ roles: ['staff'] })

      await notificationsService.notifyStaff({
        type: 'orders.placed',
        title: 'New order',
        body: 'Order #1001 needs picking.',
        dedupeKey: 'order:1001:placed',
      })

      expect(await countRows(owner.user.id)).toBe(1)
      expect(await countRows(staff.id)).toBe(1)
    })

    it('still delivers once when the same staff alert is replayed', async () => {
      const staff = await createUser({ roles: ['staff'] })
      const fanOut = () =>
        notificationsService.notifyStaff({
          type: 'orders.placed',
          title: 'New order',
          body: 'Order #1001 needs picking.',
          dedupeKey: 'order:1001:placed',
        })

      await fanOut()
      await fanOut()

      expect(await countRows(owner.user.id)).toBe(1)
      expect(await countRows(staff.id)).toBe(1)
    })
  })

  // ── Who may ask ───────────────────────────────────────────────────────────

  describe('access', () => {
    it('refuses an unauthenticated caller on every route', async () => {
      // There is no anonymous inbox. Each of these would otherwise have to
      // invent an identity from something the client supplied.
      const responses = await Promise.all([
        request(app).get('/api/v1/storefront/notifications'),
        request(app).get('/api/v1/storefront/notifications/unread-count'),
        request(app).get('/api/v1/storefront/notifications/preferences'),
        request(app).post('/api/v1/storefront/notifications/read-all'),
        request(app)
          .post('/api/v1/storefront/notifications/00000000-0000-4000-8000-000000000999/read'),
        request(app)
          .put('/api/v1/storefront/notifications/preferences')
          .send({ type: 'order.shipped', channel: 'email', enabled: false }),
      ])

      for (const res of responses) {
        expect(res.status).toBe(401)
        expect(res.body.code).toBe('UNAUTHENTICATED')
      }
    })

    it('serves a staff member their own notifications on the admin mount', async () => {
      // The same rows and the same rule; the admin surface simply already
      // requires staff, so the router is mounted without a second token check.
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      await raise(staff.user.id, { audience: 'staff', title: 'Order #1001 needs picking' })
      await raise(customer.user.id, { title: 'Not for staff eyes' })

      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', bearer(staff.accessToken))

      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].title).toBe('Order #1001 needs picking')
    })

    it('keeps the admin mount scoped to the caller, not to all staff', async () => {
      const staff = await createUserAndLogin(app, { roles: ['staff'] })
      await raise(owner.user.id, { audience: 'staff', title: 'For the owner' })

      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', bearer(staff.accessToken))

      expect(res.body.data).toEqual([])
    })

    it('turns away a customer at the admin mount', async () => {
      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', bearer(customer.accessToken))

      expect(res.status).toBe(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })
  })
})
