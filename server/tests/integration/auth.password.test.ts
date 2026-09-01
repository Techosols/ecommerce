/**
 * Password change, forgot-password and reset (§6.4).
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import {
  activeSessionCount,
  bearer,
  createUser,
  createUserAndLogin,
  DEFAULT_PASSWORD,
  emailsTo,
  eventNames,
  lastEmailTo,
  login,
  resetTokenFor,
  sessionRow,
  uniqueEmail,
} from '../factories/auth.js'
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
const NEW_PASSWORD = 'an-entirely-different-passphrase'

describeIfDatabase('password change', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('changes the password and lets the new one sign in', async () => {
    const session = await createUserAndLogin(app)

    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(session.accessToken))
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD })

    expect(res.status).toBe(200)

    const old = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: session.user.email, password: DEFAULT_PASSWORD })
    expect(old.status).toBe(401)

    const fresh = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: session.user.email, password: NEW_PASSWORD })
    expect(fresh.status).toBe(200)
  })

  it('requires the current password', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(session.accessToken))
      .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_CREDENTIALS')
  })

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(401)
  })

  it('enforces the password policy on the new password', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(session.accessToken))
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'short' })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WEAK_PASSWORD')
  })

  it('signs out every other device but keeps the session that made the change', async () => {
    const user = await createUser()
    const laptop = await login(app, user.email)
    const phone = await login(app, user.email)

    await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(laptop.accessToken))
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD })

    expect((await sessionRow(phone.sessionId))?.revoked_reason).toBe('password_changed')
    expect((await sessionRow(laptop.sessionId))?.revoked_at).toBeNull()

    const stillWorks = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', laptop.refreshCookie)
      .send({})
    expect(stillWorks.status).toBe(200)
  })

  it('publishes auth.password_changed with method=change', async () => {
    const session = await createUserAndLogin(app)
    await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(session.accessToken))
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD })

    const row = await queryOne<{ payload: { method: string } }>(
      `SELECT payload FROM domain_events WHERE name = 'auth.password_changed'`,
    )
    expect(row?.payload.method).toBe('change')
  })
})

describeIfDatabase('forgot password', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('queues a reset email for a registered address', async () => {
    const user = await createUser()
    const res = await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })

    expect(res.status).toBe(202)
    expect((await lastEmailTo(user.email))?.template).toBe('password-reset')
    expect(await eventNames()).toContain('auth.password_reset_requested')
  })

  it('answers an unknown address identically, and sends nothing', async () => {
    const user = await createUser()
    const unknown = uniqueEmail()

    const known = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: user.email })
    const missing = await request(app).post('/api/v1/auth/password/forgot').send({ email: unknown })

    expect(missing.status).toBe(known.status)
    expect(missing.body).toEqual(known.body)
    expect(await emailsTo(unknown)).toHaveLength(0)
  })

  it('keeps the reset token out of the event log', async () => {
    const user = await createUser()
    await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })
    const token = await resetTokenFor(user.email)

    const leaked = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_events WHERE payload::text LIKE '%' || $1 || '%'`,
      [token],
    )
    expect(leaked?.count).toBe(0)
  })

  it('issues a reset for a locked account — that is the unlock path', async () => {
    const user = await createUser({ status: 'locked' })
    await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })
    expect((await lastEmailTo(user.email))?.template).toBe('password-reset')
  })

  it('does not issue a reset for a disabled account', async () => {
    const user = await createUser({ status: 'disabled' })
    const res = await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })

    expect(res.status).toBe(202)
    expect(await emailsTo(user.email)).toHaveLength(0)
  })

  it('invalidates a previous reset token when a new one is requested', async () => {
    const user = await createUser()
    await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })
    const first = await resetTokenFor(user.email)

    await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })
    const second = await resetTokenFor(user.email)

    expect(second).not.toBe(first)
    const stale = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: first, password: NEW_PASSWORD })
    expect(stale.status).toBe(410)
  })
})

describeIfDatabase('password reset', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  async function requestReset(email: string): Promise<string> {
    await request(app).post('/api/v1/auth/password/forgot').send({ email })
    return resetTokenFor(email)
  }

  it('sets the new password and signs the user out everywhere', async () => {
    const session = await createUserAndLogin(app)
    expect(await activeSessionCount(session.user.id)).toBe(1)

    const token = await requestReset(session.user.email)
    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD })

    expect(res.status).toBe(200)
    expect(await activeSessionCount(session.user.id)).toBe(0)

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: session.user.email, password: NEW_PASSWORD })
    expect(relogin.status).toBe(200)
  })

  it('rejects a replayed reset token', async () => {
    const user = await createUser()
    const token = await requestReset(user.email)

    expect(
      (
        await request(app)
          .post('/api/v1/auth/password/reset')
          .send({ token, password: NEW_PASSWORD })
      ).status,
    ).toBe(200)

    const replay = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'yet-another-passphrase-x' })
    expect(replay.status).toBe(410)
  })

  it('rejects an expired reset token', async () => {
    const user = await createUser()
    const token = await requestReset(user.email)
    await execute(`UPDATE auth_tokens SET expires_at = now() - interval '2 hours'`)

    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD })
    expect(res.status).toBe(410)

    // And the old password still works, because nothing changed.
    const old = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD })
    expect(old.status).toBe(200)
  })

  it('rejects an unknown token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: 'B'.repeat(43), password: NEW_PASSWORD })
    expect(res.status).toBe(410)
  })

  it('enforces the password policy', async () => {
    const user = await createUser()
    const token = await requestReset(user.email)

    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'password123' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WEAK_PASSWORD')
  })

  it('does not spend the token on a password it rejected', async () => {
    // Consuming first and validating second would mean a user who types
    // "password123" loses the only link they have and has to start over, for a
    // request that changed nothing.
    const user = await createUser()
    const token = await requestReset(user.email)

    await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'password123' })

    const retry = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: NEW_PASSWORD })
    expect(retry.status).toBe(200)

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: NEW_PASSWORD })
    expect(relogin.status).toBe(200)
  })

  it('still spends the token exactly once under concurrency', async () => {
    const user = await createUser()
    const token = await requestReset(user.email)

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW_PASSWORD }),
      ),
    )

    // Validating before consuming must not weaken single use: the
    // compare-and-swap is still the only thing that decides the winner.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 410)).toHaveLength(3)
  })

  it('publishes auth.password_changed with method=reset', async () => {
    const user = await createUser()
    const token = await requestReset(user.email)
    await request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW_PASSWORD })

    const row = await queryOne<{ payload: { method: string } }>(
      `SELECT payload FROM domain_events WHERE name = 'auth.password_changed'`,
    )
    expect(row?.payload.method).toBe('reset')
  })
})
