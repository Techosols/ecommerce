/**
 * Registration and email verification (§6.4).
 *
 * The property under test that matters most: registration must not tell a
 * caller whether an address is already registered.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import {
  createUser,
  DEFAULT_PASSWORD,
  emailsTo,
  eventNames,
  lastEmailTo,
  uniqueEmail,
  verificationTokenFor,
} from '../factories/auth.js'
import {
  describeIfDatabase,
  setupDatabase,
  teardownDatabase,
  truncateAll,
} from '../setup/database.js'

// The queue is not running in tests; this suite is about the auth flow, not
// about pg-boss. Email rows are still written, which is what we assert on.
vi.mock('../../src/infrastructure/queue/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>()
  return { ...actual, enqueue: vi.fn(async () => 'stub-job-id') }
})

const app = createApp()

describeIfDatabase('registration', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('accepts a new account and queues a verification email', async () => {
    const email = uniqueEmail()
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: DEFAULT_PASSWORD, firstName: 'Ada' })

    expect(res.status).toBe(202)
    expect(res.body.success).toBe(true)

    const user = await usersService.getByEmail(email)
    expect(user?.roles).toEqual(['customer'])
    expect(user?.emailVerified).toBe(false)
    expect(user?.firstName).toBe('Ada')

    const message = await lastEmailTo(email)
    expect(message?.template).toBe('email-verification')
  })

  it('never returns a password hash or a token', async () => {
    const email = uniqueEmail()
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: DEFAULT_PASSWORD })

    const body = JSON.stringify(res.body)
    expect(body).not.toContain('$argon2')
    expect(body).not.toContain('passwordHash')
    expect(body).not.toContain('accessToken')
  })

  it('answers identically for an address that is already registered', async () => {
    const existing = await createUser()

    const fresh = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD })
    const duplicate = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: existing.email, password: DEFAULT_PASSWORD })

    expect(duplicate.status).toBe(fresh.status)
    expect(duplicate.body).toEqual(fresh.body)
  })

  it('warns the real account holder instead of creating a second account', async () => {
    const existing = await createUser()

    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: existing.email, password: 'a-different-password-entirely' })

    const message = await lastEmailTo(existing.email)
    expect(message?.template).toBe('account-exists')

    // And the original password still works — the attempt changed nothing.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: existing.email, password: DEFAULT_PASSWORD })
    expect(login.status).toBe(200)
  })

  it('rejects a weak password with its own code, before creating anything', async () => {
    const email = uniqueEmail()
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123' })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WEAK_PASSWORD')
    expect(await usersService.getByEmail(email)).toBeUndefined()
  })

  it('rejects a password that contains the email address', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'gardener@example.test', password: 'gardener-is-my-password' })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WEAK_PASSWORD')
  })

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: DEFAULT_PASSWORD })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('refuses to let a caller grant themselves a role or a status', async () => {
    const email = uniqueEmail()
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: DEFAULT_PASSWORD,
        roles: ['owner'],
        status: 'active',
        emailVerified: true,
      })

    // Strict schemas make mass assignment a 422 rather than a silent drop.
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body.details)).toContain('roles')
    expect(await usersService.getByEmail(email)).toBeUndefined()
  })

  it('normalises the email so casing cannot create a second account', async () => {
    const email = uniqueEmail()
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), password: DEFAULT_PASSWORD })

    const user = await usersService.getByEmail(email)
    expect(user).toBeDefined()
    expect(user?.email).toBe(email.toLowerCase())
  })

  it('publishes customer.registered inside the creating transaction', async () => {
    const email = uniqueEmail()
    await request(app).post('/api/v1/auth/register').send({ email, password: DEFAULT_PASSWORD })

    const names = await eventNames()
    expect(names).toContain('user.created')
    expect(names).toContain('customer.registered')
  })

  it('keeps the verification token out of the event log', async () => {
    const email = uniqueEmail()
    await request(app).post('/api/v1/auth/register').send({ email, password: DEFAULT_PASSWORD })

    const token = await verificationTokenFor(email)
    const leaked = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_events WHERE payload::text LIKE '%' || $1 || '%'`,
      [token],
    )
    expect(leaked?.count).toBe(0)
  })
})

describeIfDatabase('email verification', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  async function register(email: string): Promise<string> {
    await request(app).post('/api/v1/auth/register').send({ email, password: DEFAULT_PASSWORD })
    return verificationTokenFor(email)
  }

  it('verifies an address and welcomes the customer', async () => {
    const email = uniqueEmail()
    const token = await register(email)

    const res = await request(app).post('/api/v1/auth/email/verify').send({ token })
    expect(res.status).toBe(200)
    expect(res.body.data.verified).toBe(true)

    const user = await usersService.getByEmail(email)
    expect(user?.emailVerified).toBe(true)
    expect(await eventNames()).toContain('customer.email_verified')
  })

  it('rejects a replayed token — verification links are single-use', async () => {
    const email = uniqueEmail()
    const token = await register(email)

    expect((await request(app).post('/api/v1/auth/email/verify').send({ token })).status).toBe(200)

    const replay = await request(app).post('/api/v1/auth/email/verify').send({ token })
    expect(replay.status).toBe(410)
    expect(replay.body.code).toBe('LINK_EXPIRED')
  })

  it('rejects an expired token', async () => {
    const email = uniqueEmail()
    const token = await register(email)
    await execute(`UPDATE auth_tokens SET expires_at = now() - interval '1 hour'`)

    const res = await request(app).post('/api/v1/auth/email/verify').send({ token })
    expect(res.status).toBe(410)
    expect((await usersService.getByEmail(email))?.emailVerified).toBe(false)
  })

  it('rejects a token that was never issued', async () => {
    const res = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ token: 'A'.repeat(43) })
    expect(res.status).toBe(410)
  })

  it('invalidates the previous token when a new one is requested', async () => {
    const email = uniqueEmail()
    const first = await register(email)

    await request(app).post('/api/v1/auth/email/resend').send({ email })
    const second = await verificationTokenFor(email)
    expect(second).not.toBe(first)

    expect(
      (await request(app).post('/api/v1/auth/email/verify').send({ token: first })).status,
    ).toBe(410)
    expect(
      (await request(app).post('/api/v1/auth/email/verify').send({ token: second })).status,
    ).toBe(200)
  })

  it('answers a resend request identically for unknown and verified addresses', async () => {
    const verified = await createUser({ emailVerified: true })
    const unknown = uniqueEmail()

    const a = await request(app).post('/api/v1/auth/email/resend').send({ email: verified.email })
    const b = await request(app).post('/api/v1/auth/email/resend').send({ email: unknown })

    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(a.body).toEqual(b.body)

    // Neither produced an email: one is already verified, the other does not exist.
    expect(await emailsTo(unknown)).toHaveLength(0)
    expect(
      (await emailsTo(verified.email)).filter((m) => m.template === 'email-verification'),
    ).toHaveLength(0)
  })
})
