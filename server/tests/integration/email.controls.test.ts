/**
 * Which emails the shop sends, and who on the staff hears about what (§10.2).
 *
 * The three things worth holding down:
 *
 *   **One gate, not fifteen.** Every email passes through `enqueue`, so a
 *   switched-off template cannot leak through a call site somebody adds later.
 *
 *   **Account recovery cannot be switched off.** Password reset going dark
 *   produces no error anywhere — just a shop where nobody can get back in.
 *
 *   **A staff alert is a template like any other**, so it queues, dedupes and
 *   switches off through the same machinery, and goes nowhere when nobody is
 *   listed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { emailService } from '../../src/infrastructure/email/index.js'
import { emailSettingsService } from '../../src/infrastructure/email/emailSettings.service.js'
import { settingsService } from '../../src/features/settings/index.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { usersService } from '../../src/features/users/index.js'
import { bearer, createUserAndLogin } from '../factories/auth.js'
import {
  addToCart,
  checkout,
  createShippingMethod,
  guest,
  sellableProduct,
} from '../factories/commerce.js'
import { dispatchBatch } from '../../src/events/dispatcher.js'
import { registerSubscribers } from '../../src/events/index.js'
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

describeIfDatabase('email controls', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  const admin = (path: string) =>
    request(app).get(`/api/v1${path}`).set('Authorization', bearer(owner.accessToken))
  const patch = (path: string, body: object) =>
    request(app)
      .patch(`/api/v1${path}`)
      .set('Authorization', bearer(owner.accessToken))
      .send(body)

  const statusOf = (to: string) =>
    queryOne<{ status: string }>(
      `SELECT status FROM email_messages WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [to],
    )

  beforeAll(async () => {
    await setupDatabase()
    // The dispatcher runs in the worker; these tests drive it by hand, so the
    // subscribers have to be registered in this process first.
    registerSubscribers()
  })
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    settingsService.invalidate()
    emailSettingsService.invalidate()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── The switch ────────────────────────────────────────────────────────────

  describe('turning an email off', () => {
    it('lists every template, on by default', async () => {
      const res = await admin('/admin/settings/emails')

      expect(res.status).toBe(200)
      const welcome = res.body.data.find((row: { template: string }) => row.template === 'welcome')
      // Absent from the table means on: a new template ships working.
      expect(welcome).toMatchObject({ enabled: true, alwaysOn: false })
    })

    it('stops the mail without touching any call site', async () => {
      await patch('/admin/settings/emails/welcome', { enabled: false })
      emailSettingsService.invalidate()

      const result = await emailService.enqueue({
        to: 'nobody@example.test',
        template: 'welcome',
        props: { storeUrl: 'https://example.test' },
      })

      expect(result.status).toBe('disabled')
      // Recorded rather than dropped, so "why did nobody get it" is answerable.
      expect((await statusOf('nobody@example.test'))?.status).toBe('disabled')
    })

    it('is a different word from a recipient who asked us to stop', async () => {
      // `suppressed` means the person opted out; `disabled` means the shop did.
      // Collapsing them would make the suppression list meaningless.
      await patch('/admin/settings/emails/welcome', { enabled: false })
      emailSettingsService.invalidate()
      await emailService.enqueue({
        to: 'off@example.test',
        template: 'welcome',
        props: { storeUrl: 'https://example.test' },
      })

      const rows = await query<{ status: string }>(
        `SELECT status FROM email_messages WHERE to_email = 'off@example.test'`,
      )
      expect(rows[0]?.status).toBe('disabled')
      expect(rows[0]?.status).not.toBe('suppressed')
    })

    it('sends again once it is switched back on', async () => {
      await patch('/admin/settings/emails/welcome', { enabled: false })
      await patch('/admin/settings/emails/welcome', { enabled: true })
      emailSettingsService.invalidate()

      const result = await emailService.enqueue({
        to: 'back-on@example.test',
        template: 'welcome',
        props: { storeUrl: 'https://example.test' },
      })

      expect(result.status).toBe('queued')
    })
  })

  // ── The ones that must never go dark ──────────────────────────────────────

  // ── Proving delivery works at all ─────────────────────────────────────────

  describe('the delivery test', () => {
    const post = (path: string, body: object) =>
      request(app)
        .post(`/api/v1${path}`)
        .set('Authorization', bearer(owner.accessToken))
        .send(body)

    it('sends the check message to the address given', async () => {
      const res = await post('/admin/settings/emails/test', { to: 'me@personal.test' })

      expect(res.status).toBe(202)
      const row = await queryOne<{ template: string; status: string }>(
        `SELECT template, status FROM email_messages WHERE to_email = 'me@personal.test'`,
      )
      expect(row?.template).toBe('system-check')
      expect(row?.status).toBe('queued')
    })

    it('can be sent to the same address twice', async () => {
      // An operator fixing an SMTP setting tries again a minute later. A dedupe
      // key would swallow the second attempt and look like the fix failed.
      await post('/admin/settings/emails/test', { to: 'me@personal.test' })
      const second = await post('/admin/settings/emails/test', { to: 'me@personal.test' })

      expect(second.status).toBe(202)
      const rows = await query(
        `SELECT id FROM email_messages WHERE to_email = 'me@personal.test'`,
      )
      expect(rows).toHaveLength(2)
    })

    it('refuses something that is not an address', async () => {
      const res = await post('/admin/settings/emails/test', { to: 'not-an-address' })
      expect(res.status).toBe(422)
    })

    it('cannot be sent without permission to change settings', async () => {
      // It sends mail from the shop's own address; reading settings is not
      // enough to do that.
      const nobody = await createUserAndLogin(app, { roles: ['customer'] })

      const res = await request(app)
        .post('/api/v1/admin/settings/emails/test')
        .set('Authorization', bearer(nobody.accessToken))
        .send({ to: 'me@personal.test' })

      expect(res.status).toBe(403)
    })

    it('goes out even when every other template is switched off', async () => {
      // The one message that must work when nothing else does — it is how you
      // find out whether the problem is the switches or the mail server.
      await patch('/admin/settings/emails/order-placed', { enabled: false })
      emailSettingsService.invalidate()

      const res = await post('/admin/settings/emails/test', { to: 'me@personal.test' })

      expect(res.status).toBe(202)
      expect(res.body.data.status).toBe('queued')
    })
  })

  // ── Seeing what happened ──────────────────────────────────────────────────

  describe('the mail log', () => {
    /** Puts one message in each state worth telling apart. */
    async function seed() {
      const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }
      const a = await emailService.enqueue({ to: 'sent@shop.test', template: 'system-check', props })
      const b = await emailService.enqueue({ to: 'stuck@shop.test', template: 'system-check', props })
      await query(`UPDATE email_messages SET status = 'sent', sent_at = now() WHERE id = $1`, [a.id])
      await query(
        `UPDATE email_messages SET status = 'failed', attempts = 5, last_error = $2 WHERE id = $1`,
        [b.id, '550 5.7.1 Relaying denied'],
      )
    }

    it('shows what was sent, to whom, and what became of it', async () => {
      await seed()

      const res = await admin('/admin/settings/emails/log')

      expect(res.status).toBe(200)
      const byTo = Object.fromEntries(
        res.body.data.map((row: { to: string; status: string }) => [row.to, row.status]),
      )
      expect(byTo['sent@shop.test']).toBe('sent')
      expect(byTo['stuck@shop.test']).toBe('failed')
    })

    it('carries the provider’s own words about a failure', async () => {
      // "550 relaying denied" tells an operator to fix their SMTP relay.
      // "could not send" tells them nothing at all.
      await seed()

      const res = await admin('/admin/settings/emails/log?status=failed')

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].lastError).toBe('550 5.7.1 Relaying denied')
      expect(res.body.data[0].attempts).toBe(5)
    })

    it('counts the states, because a page of successes hides the failures', async () => {
      await seed()

      const res = await admin('/admin/settings/emails/log')

      expect(res.body.meta.summary).toMatchObject({ sent: 1, failed: 1 })
    })

    it('narrows to one recipient', async () => {
      await seed()

      const res = await admin('/admin/settings/emails/log?to=stuck@shop.test')

      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].to).toBe('stuck@shop.test')
    })

    it('does not carry the message body or its props', async () => {
      // The props of an order email hold the customer's name and full delivery
      // address. A screen about delivery must not become a second place to read
      // them.
      await seed()

      const res = await admin('/admin/settings/emails/log')

      expect(res.body.data[0]).not.toHaveProperty('payload')
      expect(res.body.data[0]).not.toHaveProperty('props')
      expect(res.body.data[0]).not.toHaveProperty('html')
    })

    it('can send a failed message again once the cause is fixed', async () => {
      /**
       * A worker running a build that did not yet have a template marks the
       * message `failed` permanently — and the sweep will not touch a failed
       * row. Without this the message is dead even after the worker is fixed,
       * and the only recourse is asking the customer to order again.
       */
      const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }
      const { id } = await emailService.enqueue({
        to: 'retry@shop.test',
        template: 'system-check',
        props,
      })
      await query(
        `UPDATE email_messages SET status = 'failed', attempts = 5, last_error = $2 WHERE id = $1`,
        [id, 'unknown template "admin-order-placed"'],
      )

      const res = await request(app)
        .post(`/api/v1/admin/settings/emails/log/${id}/retry`)
        .set('Authorization', bearer(owner.accessToken))
        .send({})

      expect(res.status).toBe(202)
      const row = await queryOne<{ status: string; attempts: number; last_error: string | null }>(
        'SELECT status, attempts, last_error FROM email_messages WHERE id = $1',
        [id],
      )
      // A person deciding to try again after changing something, not the queue
      // grinding through its retries — so the count starts over and the stale
      // error goes.
      expect(row?.status).toBe('queued')
      expect(row?.attempts).toBe(0)
      expect(row?.last_error).toBeNull()
    })

    it('refuses to send a delivered message a second time', async () => {
      // A duplicate order confirmation is a worse outcome than none.
      const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }
      const { id } = await emailService.enqueue({
        to: 'done@shop.test',
        template: 'system-check',
        props,
      })
      await query(`UPDATE email_messages SET status = 'sent' WHERE id = $1`, [id])

      const res = await request(app)
        .post(`/api/v1/admin/settings/emails/log/${id}/retry`)
        .set('Authorization', bearer(owner.accessToken))
        .send({})

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/sent/)
    })

    it('needs permission to put mail on the wire', async () => {
      const props = { environment: 'test', triggeredAt: '2026-08-29T10:00:00Z' }
      const { id } = await emailService.enqueue({
        to: 'nope@shop.test',
        template: 'system-check',
        props,
      })
      const nobody = await createUserAndLogin(app, { roles: ['customer'] })

      const res = await request(app)
        .post(`/api/v1/admin/settings/emails/log/${id}/retry`)
        .set('Authorization', bearer(nobody.accessToken))
        .send({})

      expect(res.status).toBe(403)
    })

    it('is not readable without permission', async () => {
      const nobody = await createUserAndLogin(app, { roles: ['customer'] })

      const res = await request(app)
        .get('/api/v1/admin/settings/emails/log')
        .set('Authorization', bearer(nobody.accessToken))

      expect(res.status).toBe(403)
    })
  })

  describe('account recovery', () => {
    it('refuses to switch off password reset, and says why', async () => {
      const res = await patch('/admin/settings/emails/password-reset', { enabled: false })

      expect(res.status).toBe(422)
      expect(res.body.message).toMatch(/cannot be switched off/i)
      expect(res.body.message).toMatch(/forgotten password/i)
    })

    it('marks them always-on in the list rather than hiding them', async () => {
      // Hiding the switch sends somebody looking for one that was removed.
      const res = await admin('/admin/settings/emails')
      const reset = res.body.data.find(
        (row: { template: string }) => row.template === 'password-reset',
      )
      expect(reset).toMatchObject({ alwaysOn: true, enabled: true })
      expect(reset.alwaysOnReason).toBeTruthy()
    })

    it('sends even if a row in the table says otherwise', async () => {
      // Code is the authority, not the table: a bad migration or a direct
      // UPDATE must not be able to lock every customer out of their account.
      await query(
        `INSERT INTO email_template_settings (template, enabled) VALUES ('password-reset', false)`,
      )
      emailSettingsService.invalidate()

      expect(await emailSettingsService.isEnabled('password-reset')).toBe(true)
    })
  })

  // ── Alerts to the shop ────────────────────────────────────────────────────

  describe('telling staff about an order', () => {
    it('goes nowhere while no addresses are listed', async () => {
      const settings = await settingsService.get()
      expect(settings.adminNotificationEmails).toEqual([])
    })

    it('accepts a list of addresses', async () => {
      const res = await patch('/admin/settings', {
        adminNotificationEmails: ['owner@shop.test', 'warehouse@shop.test'],
      })

      expect(res.status).toBe(200)
      expect(res.body.data.adminNotificationEmails).toEqual([
        'owner@shop.test',
        'warehouse@shop.test',
      ])
    })

    it('refuses something that is not an address', async () => {
      const res = await patch('/admin/settings', { adminNotificationEmails: ['not-an-email'] })
      expect(res.status).toBe(422)
    })

    it('emails every listed address when an order is placed', async () => {
      await patch('/admin/settings', {
        adminNotificationEmails: ['owner@shop.test', 'warehouse@shop.test'],
      })
      settingsService.invalidate()

      const { methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 })
      const product = await sellableProduct(app, owner.accessToken, { priceAmount: 5000 })
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      const placed = await checkout(shopper, { shippingMethodId: methodId })
      expect(placed.status).toBe(201)

      await dispatchBatch()

      const rows = await query<{ to_email: string; template: string; subject: string }>(
        `SELECT to_email, template, subject FROM email_messages WHERE template = 'admin-order-placed'
          ORDER BY to_email`,
      )
      // One message each, not one message to many: a bounce from the warehouse
      // address must not take the owner's copy with it.
      expect(rows.map((row) => row.to_email)).toEqual(['owner@shop.test', 'warehouse@shop.test'])
      expect(rows[0]?.subject).toMatch(new RegExp(placed.body.data.orderNumber))

      // And the customer still got their own, different email.
      const customer = await query<{ template: string }>(
        `SELECT template FROM email_messages WHERE to_email = 'buyer@example.test'`,
      )
      expect(customer.map((row) => row.template)).toContain('order-placed')
    })

    it('says plainly when an order is not paid yet', async () => {
      // The difference between "pack this" and "wait", at the top of the mail.
      await patch('/admin/settings', { adminNotificationEmails: ['owner@shop.test'] })
      settingsService.invalidate()

      const { methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId, paymentMethod: 'cod' })
      await dispatchBatch()

      const row = await queryOne<{ payload: { actionNeeded?: string; paymentStatus: string } }>(
        `SELECT payload FROM email_messages WHERE template = 'admin-order-placed' LIMIT 1`,
      )
      expect(row?.payload.paymentStatus).toBe('Awaiting payment')
      expect(row?.payload.actionNeeded).toMatch(/do not ship/i)
    })

    it('sends nothing to staff while the alert is switched off', async () => {
      await patch('/admin/settings', { adminNotificationEmails: ['owner@shop.test'] })
      await patch('/admin/settings/emails/admin-order-placed', { enabled: false })
      settingsService.invalidate()
      emailSettingsService.invalidate()

      const { methodId } = await createShippingMethod(app, owner.accessToken, { priceCents: 499 })
      const product = await sellableProduct(app, owner.accessToken)
      const shopper = guest(app)
      await addToCart(shopper, product.variants[0]!.id, 1)
      await checkout(shopper, { shippingMethodId: methodId })
      await dispatchBatch()

      const rows = await query<{ status: string }>(
        `SELECT status FROM email_messages WHERE template = 'admin-order-placed'`,
      )
      // Recorded as disabled rather than absent, so the decision is visible.
      expect(rows.every((row) => row.status === 'disabled')).toBe(true)
    })

    it('can be switched off like any other template', async () => {
      // The point of making staff alerts ordinary templates: no second
      // mechanism to learn, and the same switch turns them off.
      const res = await admin('/admin/settings/emails')
      const alert = res.body.data.find(
        (row: { template: string }) => row.template === 'admin-order-placed',
      )
      expect(alert).toMatchObject({ enabled: true, alwaysOn: false })

      const toggled = await patch('/admin/settings/emails/admin-order-placed', { enabled: false })
      expect(toggled.status).toBe(200)
    })
  })
})
