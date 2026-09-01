/**
 * Customers as records a shop works with (§12).
 *
 * The things worth proving here are the ones that are quietly wrong in most
 * shops: consent that collapses "never asked" into "said no", lifetime figures
 * that drift from the orders they claim to summarise, a merge that adds two
 * totals together and doubles whatever was counted on both sides, and a rule
 * engine that reaches SQL with a field name somebody typed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { usersService } from '../../src/features/users/index.js'
import { bearer, createUserAndLogin, lastEmailTo, uniqueEmail } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createShippingMethod,
  guest,
  sellableProduct,
} from '../factories/commerce.js'
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

describeIfDatabase('customers — CRM', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>
  let methodId: string
  let keyCounter = 0

  const get = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const patch = (path: string, body: object = {}) =>
    request(app)
      .patch(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .send(body)
  const del = (path: string, body: object = {}) =>
    request(app)
      .delete(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .send(body)
  const post = (path: string, body: object = {}) => {
    keyCounter += 1
    return request(app)
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .set('Idempotency-Key', `00000000-0000-4000-b000-${String(keyCounter).padStart(12, '0')}`)
      .send(body)
  }

  /** A customer created through the admin surface. */
  async function customer(overrides: Record<string, unknown> = {}) {
    const res = await post('/admin/customers', {
      email: uniqueEmail('shopper'),
      firstName: 'Ada',
      lastName: 'Lovelace',
      ...overrides,
    })
    expect(res.status).toBe(201)
    return res.body.data as {
      id: string
      email: string
      tags: string[]
      marketing: { email: string; sms: string; optInLevel: string | null }
      ordersCount: number
      totalSpent: { amount: number; currency: string }
      firstOrderAt: string | null
      taxExempt: boolean
    }
  }

  /** Signs the customer in, so an order can be attributed to them. */
  async function shopperToken(email: string) {
    const password = 'correct-horse-battery-staple'
    const user = await queryOne<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      email.toLowerCase(),
    ])
    const { hashPassword } = await import('../../src/shared/auth/password.js')
    await execute(`UPDATE users SET password_hash = $2, email_verified_at = now() WHERE id = $1`, [
      user?.id,
      await hashPassword(password),
    ])
    usersService.invalidateAccess(user!.id)

    const res = await request(app).post('/api/v1/auth/login').send({ email, password })
    expect(res.status).toBe(200)
    return res.body.data.accessToken as string
  }

  /**
   * Places a real order for a signed-in customer and confirms it.
   *
   * The confirmation matters: lifetime figures are written when an order is
   * confirmed, not when it is placed, because a basket that never becomes an
   * order is not something the customer spent.
   */
  async function placeOrder(token: string, email: string, priceAmount = 2500) {
    const product = await sellableProduct(app, owner.accessToken, { priceAmount, quantity: 20 })
    const shopper = guest(app)
    await addToCart(shopper, product.variants[0]!.id, 1)
    const placed = await checkout(shopper, { shippingMethodId: methodId, email, token })
    expect(placed.status).toBe(201)

    const orderId = placed.body.data.id as string
    expect((await post(`/admin/orders/${orderId}/confirm`)).status).toBe(200)

    return placed.body.data as { id: string; totals: { total: { amount: number } } }
  }

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
    ;({ methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 0 }))
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Creating a record ─────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a customer nobody can sign in as', async () => {
      const created = await customer({ tags: ['vip', 'VIP', ' wholesale '], taxExempt: true })

      expect(created.taxExempt).toBe(true)
      // De-duped case-insensitively, first spelling kept.
      expect(created.tags).toEqual(['vip', 'wholesale'])
      expect(created.marketing.email).toBe('not_subscribed')

      const row = await queryOne<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [created.id],
      )
      expect(row?.password_hash).toBeNull()
    })

    it('mails a set-password link when the access is an invite', async () => {
      const email = uniqueEmail('invited')
      const res = await post('/admin/customers', { email, access: 'invite' })
      expect(res.status).toBe(201)

      // The invite reuses the reset flow rather than a parallel token scheme.
      const mail = await lastEmailTo(email)
      expect(mail).toBeDefined()
    })

    it('refuses a password access with no password', async () => {
      const res = await post('/admin/customers', {
        email: uniqueEmail(),
        access: 'password',
      })
      expect(res.status).toBe(422)
    })

    it('refuses an email that already has an account', async () => {
      const first = await customer()
      const res = await post('/admin/customers', { email: first.email })
      expect(res.status).toBe(409)
    })

    it('records the creation on the timeline', async () => {
      const created = await customer()
      const events = await get(`/admin/customers/${created.id}/events`)

      expect(events.body.data[0].kind).toBe('account.created_by_staff')
      expect(events.body.data[0].actorName).toBe(owner.user.email)
    })
  })

  // ── Lifetime figures ──────────────────────────────────────────────────────

  describe('rollups', () => {
    it('counts an order against the customer who placed it', async () => {
      const created = await customer()
      const token = await shopperToken(created.email)
      const order = await placeOrder(token, created.email)

      const res = await get(`/admin/customers/${created.id}`)
      expect(res.body.data.ordersCount).toBe(1)
      expect(res.body.data.totalSpent.amount).toBe(order.totals.total.amount)
      expect(res.body.data.firstOrderAt).not.toBeNull()
      expect(res.body.data.averageOrderValue.amount).toBe(order.totals.total.amount)
    })

    it('rebuilds figures that have drifted from the orders', async () => {
      const created = await customer()
      const token = await shopperToken(created.email)
      const order = await placeOrder(token, created.email)

      // Whatever put these out of step — an old bug, a restore, a hand-edit —
      // the recompute must be able to bring them back.
      await execute(
        `UPDATE users SET orders_count = 99, total_spent_cents = 1, first_order_at = NULL WHERE id = $1`,
        [created.id],
      )

      const res = await post(`/admin/customers/${created.id}/recompute-metrics`)
      expect(res.status).toBe(200)
      expect(res.body.data.ordersCount).toBe(1)
      expect(res.body.data.totalSpent.amount).toBe(order.totals.total.amount)
      expect(res.body.data.firstOrderAt).not.toBeNull()
    })

    it('rebuilds every customer at once', async () => {
      await customer()
      await customer()

      const res = await post('/admin/customers/recompute-metrics')
      expect(res.status).toBe(200)
      expect(res.body.data.customers).toBeGreaterThanOrEqual(2)
    })
  })

  // ── Tags ──────────────────────────────────────────────────────────────────

  describe('tags', () => {
    it('adds, de-dupes and removes', async () => {
      const created = await customer()

      const added = await post(`/admin/customers/${created.id}/tags`, { tags: ['vip', 'trade'] })
      // Order is the order they were added in; a shop's tags are a list, not a
      // set somebody sorted.
      expect(added.body.data.tags).toEqual(['vip', 'trade'])

      const again = await post(`/admin/customers/${created.id}/tags`, { tags: ['VIP'] })
      expect(again.body.data.tags.filter((t: string) => t.toLowerCase() === 'vip')).toHaveLength(1)

      const removed = await del(`/admin/customers/${created.id}/tags`, { tags: ['vip'] })
      expect(removed.body.data.tags).not.toContain('vip')
    })

    it('refuses a blank tag at the boundary', async () => {
      const created = await customer()
      const res = await post(`/admin/customers/${created.id}/tags`, { tags: ['  '] })
      expect(res.status).toBe(422)
    })

    it('narrows the list to customers holding every tag asked for', async () => {
      const both = await customer()
      const one = await customer()
      await post(`/admin/customers/${both.id}/tags`, { tags: ['vip', 'trade'] })
      await post(`/admin/customers/${one.id}/tags`, { tags: ['vip'] })

      const res = await get('/admin/customers?tags=vip&tags=trade')
      const ids = res.body.data.map((c: { id: string }) => c.id)
      expect(ids).toContain(both.id)
      expect(ids).not.toContain(one.id)
    })
  })

  // ── Consent ───────────────────────────────────────────────────────────────

  describe('marketing consent', () => {
    it('keeps "never asked" and "said no" apart', async () => {
      const created = await customer()
      expect(created.marketing.email).toBe('not_subscribed')

      await patch(`/admin/customers/${created.id}/marketing`, {
        channel: 'email',
        state: 'subscribed',
        optInLevel: 'confirmed_opt_in',
      })
      const off = await patch(`/admin/customers/${created.id}/marketing`, {
        channel: 'email',
        state: 'unsubscribed',
      })

      expect(off.body.data.marketing.email).toBe('unsubscribed')

      // Both states are "not receiving mail", and only one of them may be asked
      // again. A filter that could not tell them apart would be the bug.
      const unsubscribed = await get('/admin/customers?marketingEmailState=unsubscribed')
      expect(unsubscribed.body.data.map((c: { id: string }) => c.id)).toContain(created.id)
      const never = await get('/admin/customers?marketingEmailState=not_subscribed')
      expect(never.body.data.map((c: { id: string }) => c.id)).not.toContain(created.id)
    })

    it('derives accepts_marketing from the email state and never stores a second copy', async () => {
      const created = await customer()
      await patch(`/admin/customers/${created.id}/marketing`, {
        channel: 'email',
        state: 'subscribed',
      })

      const row = await queryOne<{ accepts_marketing: boolean }>(
        `SELECT accepts_marketing FROM users WHERE id = $1`,
        [created.id],
      )
      expect(row?.accepts_marketing).toBe(true)

      // Generated columns cannot be written; anything that tried would fail here.
      await expect(
        execute(`UPDATE users SET accepts_marketing = false WHERE id = $1`, [created.id]),
      ).rejects.toBeTruthy()
    })

    it('treats sms as its own channel', async () => {
      const created = await customer()
      const res = await patch(`/admin/customers/${created.id}/marketing`, {
        channel: 'sms',
        state: 'subscribed',
      })

      expect(res.body.data.marketing.sms).toBe('subscribed')
      expect(res.body.data.marketing.email).toBe('not_subscribed')
    })

    it('writes every consent move to the timeline', async () => {
      const created = await customer()
      await patch(`/admin/customers/${created.id}/marketing`, {
        channel: 'email',
        state: 'subscribed',
      })

      const events = await get(`/admin/customers/${created.id}/events`)
      const entry = events.body.data.find(
        (e: { kind: string }) => e.kind === 'marketing.consent_changed',
      )
      expect(entry.metadata).toMatchObject({
        channel: 'email',
        from: 'not_subscribed',
        to: 'subscribed',
      })
    })
  })

  // ── Timeline ──────────────────────────────────────────────────────────────

  describe('timeline', () => {
    it('adds a note and deletes it again', async () => {
      const created = await customer()
      const note = await post(`/admin/customers/${created.id}/events`, {
        body: 'Rang about the delayed order.',
      })
      expect(note.status).toBe(201)
      expect(note.body.data.actorName).toBe(owner.user.email)

      const removed = await del(`/admin/customers/${created.id}/events/${note.body.data.id}`)
      expect(removed.status).toBe(204)

      const events = await get(`/admin/customers/${created.id}/events`)
      expect(events.body.data.map((e: { id: string }) => e.id)).not.toContain(note.body.data.id)
    })

    it('refuses to delete a system observation', async () => {
      const created = await customer()
      const events = await get(`/admin/customers/${created.id}/events`)
      const system = events.body.data.find((e: { kind: string }) => e.kind !== 'note')

      const res = await del(`/admin/customers/${created.id}/events/${system.id}`)
      // Evidence, not somebody's to take back.
      expect(res.status).toBe(404)
    })

    it('refuses an empty note', async () => {
      const created = await customer()
      const res = await post(`/admin/customers/${created.id}/events`, { body: '   ' })
      expect(res.status).toBe(422)
    })
  })

  // ── Merge ─────────────────────────────────────────────────────────────────

  describe('merge', () => {
    it('moves the orders, keeps the tags, and recomputes rather than adds', async () => {
      const survivor = await customer()
      const duplicate = await customer()
      await post(`/admin/customers/${duplicate.id}/tags`, { tags: ['trade'] })

      const survivorToken = await shopperToken(survivor.email)
      const duplicateToken = await shopperToken(duplicate.email)
      const a = await placeOrder(survivorToken, survivor.email, 2500)
      const b = await placeOrder(duplicateToken, duplicate.email, 4000)

      const res = await post(`/admin/customers/${survivor.id}/merge`, {
        duplicateId: duplicate.id,
      })
      expect(res.status).toBe(200)
      expect(res.body.data.ordersCount).toBe(2)
      expect(res.body.data.totalSpent.amount).toBe(a.totals.total.amount + b.totals.total.amount)
      expect(res.body.data.tags).toContain('trade')

      // The duplicate is gone, and its orders are not.
      expect((await get(`/admin/customers/${duplicate.id}`)).status).toBe(404)
      const moved = await queryOne<{ customer_id: string }>(
        `SELECT customer_id FROM orders WHERE id = $1`,
        [b.id],
      )
      expect(moved?.customer_id).toBe(survivor.id)
    })

    it('refuses to merge a customer into themselves', async () => {
      const created = await customer()
      const res = await post(`/admin/customers/${created.id}/merge`, { duplicateId: created.id })
      expect(res.status).toBe(422)
    })
  })

  // ── The list ──────────────────────────────────────────────────────────────

  describe('list filters', () => {
    it('narrows by spend, order count and sorts by what was spent', async () => {
      const spender = await customer()
      await customer()
      const token = await shopperToken(spender.email)
      await placeOrder(token, spender.email, 9000)

      const withOrders = await get('/admin/customers?hasOrders=true')
      expect(withOrders.body.data.map((c: { id: string }) => c.id)).toEqual([spender.id])

      const rich = await get('/admin/customers?minSpent=5000')
      expect(rich.body.data.map((c: { id: string }) => c.id)).toEqual([spender.id])

      const sorted = await get('/admin/customers?sort=spend&direction=desc')
      expect(sorted.body.data[0].id).toBe(spender.id)
      // The vocabulary the filter drawer is generated from travels with the list.
      expect(sorted.body.meta.ruleFields).toContain('totalSpent')
    })

    it('never lists staff among the customers', async () => {
      await customer()
      const res = await get('/admin/customers')
      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(owner.user.id)
    })
  })

  // ── Export ────────────────────────────────────────────────────────────────

  describe('export', () => {
    it('exports the filtered view, not everything', async () => {
      const tagged = await customer()
      await customer()
      await post(`/admin/customers/${tagged.id}/tags`, { tags: ['vip'] })

      const res = await get('/admin/customers/export?tags=vip')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/csv/)

      const lines = res.text.trim().split('\n')
      expect(lines[0]).toContain('email')
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain(tagged.email)
    })

    it('defuses a cell a spreadsheet would execute', async () => {
      const created = await customer({ firstName: '=cmd|calc' })

      const res = await get('/admin/customers/export')
      // Prefixed with a quote, so Excel reads it as text rather than a formula.
      expect(res.text).toContain(`"'=cmd|calc"`)
      expect(res.text).toContain(created.email)
    })
  })

  // ── Segments ──────────────────────────────────────────────────────────────

  describe('segments', () => {
    const spent = (amount: number) => ({
      match: 'all' as const,
      conditions: [{ field: 'totalSpent', operator: 'gte', value: amount }],
    })

    it('previews a rule set without saving it', async () => {
      const spender = await customer()
      await customer()
      const token = await shopperToken(spender.email)
      await placeOrder(token, spender.email, 9000)

      const res = await post('/admin/customers/segments/preview', { rules: spent(5000) })
      expect(res.status).toBe(200)
      expect(res.body.data.memberCount).toBe(1)
      expect(res.body.data.sample[0].id).toBe(spender.id)
      expect(res.body.data.summary).toMatch(/Total spent/)

      expect((await get('/admin/customers/segments')).body.data).toEqual([])
    })

    it('counts members live rather than storing a membership', async () => {
      const created = await post('/admin/customers/segments', {
        name: 'Big spenders',
        rules: spent(5000),
      })
      expect(created.status).toBe(201)
      expect(created.body.data.memberCount ?? 0).toBe(0)

      const spender = await customer()
      const token = await shopperToken(spender.email)
      await placeOrder(token, spender.email, 9000)

      // Nothing was recalculated on write; the segment simply asks again.
      const after = await get(`/admin/customers/segments/${created.body.data.id}`)
      expect(after.body.data.memberCount).toBe(1)
    })

    it('narrows the customer list to a segment', async () => {
      const spender = await customer()
      const quiet = await customer()
      const token = await shopperToken(spender.email)
      await placeOrder(token, spender.email, 9000)

      const segment = await post('/admin/customers/segments', {
        name: 'Big spenders',
        rules: spent(5000),
      })

      const res = await get(`/admin/customers?segmentId=${segment.body.data.id}`)
      const ids = res.body.data.map((c: { id: string }) => c.id)
      expect(ids).toEqual([spender.id])
      expect(ids).not.toContain(quiet.id)
    })

    it('combines conditions with any as well as all', async () => {
      const tagged = await customer()
      await post(`/admin/customers/${tagged.id}/tags`, { tags: ['vip'] })
      const other = await customer()

      const res = await post('/admin/customers/segments/preview', {
        rules: {
          match: 'any',
          conditions: [
            { field: 'tags', operator: 'contains', value: 'vip' },
            { field: 'totalSpent', operator: 'gte', value: 1_000_000 },
          ],
        },
      })
      expect(res.body.data.sample.map((c: { id: string }) => c.id)).toEqual([tagged.id])
      expect(res.body.data.memberCount).toBe(1)
      expect(other.id).toBeDefined()
    })

    it('refuses a field that is not in the catalogue', async () => {
      const res = await post('/admin/customers/segments/preview', {
        rules: {
          match: 'all',
          conditions: [{ field: 'password_hash', operator: 'is_set' }],
        },
      })
      expect(res.status).toBe(422)
    })

    it('refuses an operator the field type does not have', async () => {
      const res = await post('/admin/customers/segments/preview', {
        rules: {
          match: 'all',
          conditions: [{ field: 'taxExempt', operator: 'contains', value: 'x' }],
        },
      })
      expect(res.status).toBe(422)
    })

    it('binds values instead of interpolating them', async () => {
      const created = await customer()

      // If any of this reached the query as text rather than a parameter, the
      // users table would not survive the request.
      const res = await post('/admin/customers/segments/preview', {
        rules: {
          match: 'all',
          conditions: [
            { field: 'email', operator: 'equals', value: `x'; DROP TABLE users; --` },
          ],
        },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.memberCount).toBe(0)

      expect((await get(`/admin/customers/${created.id}`)).status).toBe(200)
    })

    it('refuses a second segment with the same name', async () => {
      await post('/admin/customers/segments', { name: 'Big spenders', rules: spent(5000) })
      const res = await post('/admin/customers/segments', {
        name: 'BIG SPENDERS',
        rules: spent(1),
      })
      expect(res.status).toBe(409)
    })

    it('refuses rules that cannot be compiled, before they are stored', async () => {
      const res = await post('/admin/customers/segments', {
        name: 'Broken',
        rules: { match: 'all', conditions: [{ field: 'nope', operator: 'equals', value: 1 }] },
      })
      expect(res.status).toBe(422)
      expect((await get('/admin/customers/segments')).body.data).toEqual([])
    })

    it('edits and deletes a segment', async () => {
      const created = await post('/admin/customers/segments', {
        name: 'Big spenders',
        rules: spent(5000),
      })

      const renamed = await patch(`/admin/customers/segments/${created.body.data.id}`, {
        name: 'Very big spenders',
        rules: spent(50_000),
      })
      expect(renamed.body.data.name).toBe('Very big spenders')

      expect((await del(`/admin/customers/segments/${created.body.data.id}`)).status).toBe(204)
      expect((await get(`/admin/customers/segments/${created.body.data.id}`)).status).toBe(404)
    })

    it('publishes the field catalogue the builder is generated from', async () => {
      const res = await get('/admin/customers/segments/fields')
      expect(res.status).toBe(200)

      const totalSpent = res.body.data.find((f: { key: string }) => f.key === 'totalSpent')
      expect(totalSpent.operators).toContain('gte')
      // The SQL each field stands for is the server's business and stays there.
      expect(JSON.stringify(res.body.data)).not.toContain('total_spent_cents')
    })
  })

  // ── Permissions ───────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('refuses a customer their own admin surface', async () => {
      const created = await customer()
      const token = await shopperToken(created.email)

      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', bearer(token))
      expect(res.status).toBe(403)
    })
  })
})
