/**
 * Login, token validation and lockout (§6.2, §6.4).
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { env } from '../../src/config/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute } from '../../src/infrastructure/database/query.js'
import { signAccessToken } from '../../src/shared/auth/tokens.js'
import {
  activeSessionCount,
  bearer,
  createUser,
  createUserAndLogin,
  DEFAULT_PASSWORD,
  eventNames,
  login,
  refreshCookieFrom,
  uniqueEmail,
  userStatus,
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

describeIfDatabase('login', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('returns an access token, the current user, and a refresh cookie', async () => {
    const user = await createUser()
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })

    expect(res.status).toBe(200)
    expect(res.body.data.tokenType).toBe('Bearer')
    expect(res.body.data.expiresIn).toBeGreaterThan(0)
    expect(res.body.data.user.email).toBe(user.email)
    expect(res.body.data.user.roles).toEqual(['customer'])
    expect(res.body.data.user.permissions).toEqual([])
    expect(res.body.data.user.isStaff).toBe(false)

    const cookie = refreshCookieFrom(res.headers as Record<string, unknown>)
    expect(cookie).toContain('refresh_token=')
  })

  it('sets the refresh cookie httpOnly, SameSite and scoped to the auth path', async () => {
    const user = await createUser()
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })

    const setCookie = (res.headers as unknown as Record<string, string[]>)['set-cookie'] ?? []
    const raw = setCookie.find((c) => c.startsWith('refresh_token='))!
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('Path=/api/v1/auth')
    expect(raw.toLowerCase()).toContain('samesite=strict')
  })

  it('never puts the refresh token in the response body', async () => {
    const user = await createUser()
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
    expect(JSON.stringify(res.body)).not.toContain('refreshToken')
  })

  it('rejects a wrong password with the generic code', async () => {
    const user = await createUser()
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not-the-right-password' })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_CREDENTIALS')
  })

  it('answers an unknown email exactly as it answers a wrong password', async () => {
    const user = await createUser()

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'nope-nope-nope' })
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'nope-nope-nope' })

    expect(unknownEmail.status).toBe(wrongPassword.status)
    expect(unknownEmail.body.code).toBe(wrongPassword.body.code)
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message)
  })

  it('refuses a disabled account without admitting that it exists', async () => {
    const user = await createUser({ status: 'disabled' })
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_CREDENTIALS')
    expect(JSON.stringify(res.body)).not.toContain('disabled')
  })

  it('refuses a locked account with the same generic answer', async () => {
    const user = await createUser({ status: 'locked' })
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_CREDENTIALS')
  })

  it('refuses an account with no password set', async () => {
    const user = await createUser({ password: null })
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD })
    expect(res.status).toBe(401)
  })

  it('allows an unverified customer to sign in', async () => {
    // A deliberate product decision: verification is encouraged, not a gate, so
    // email deliverability problems cannot lock people out of the store.
    const user = await createUser({ emailVerified: false })
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })

    expect(res.status).toBe(200)
    expect(res.body.data.user.emailVerified).toBe(false)
  })

  it('records the attempt and the login timestamp', async () => {
    const user = await createUser()
    await login(app, user.email)

    const { queryOne } = await import('../../src/infrastructure/database/query.js')
    const attempts = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM login_attempts WHERE email = $1 AND success = true`,
      [user.email],
    )
    expect(attempts?.count).toBe(1)

    const row = await queryOne<{ last_login_at: Date | null }>(
      `SELECT last_login_at FROM users WHERE id = $1`,
      [user.id],
    )
    expect(row?.last_login_at).not.toBeNull()
  })

  it('never records the password that was tried', async () => {
    const user = await createUser()
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'a-very-distinctive-secret' })

    const { query } = await import('../../src/infrastructure/database/query.js')
    const rows = await query<{ row: string }>(
      `SELECT login_attempts::text AS row FROM login_attempts`,
    )
    expect(JSON.stringify(rows)).not.toContain('a-very-distinctive-secret')
  })

  it('publishes auth.login_succeeded', async () => {
    const user = await createUser()
    await login(app, user.email)
    expect(await eventNames()).toContain('auth.login_succeeded')
  })

  it('locks the account after the configured number of failures, and the reset unlocks it', async () => {
    const user = await createUser()

    for (let i = 0; i < env.LOGIN_MAX_FAILURES; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: `wrong-${i}` })
    }

    expect(await userStatus(user.id)).toBe('locked')

    // The correct password no longer works while locked.
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
    expect(blocked.status).toBe(401)

    // Password reset is the documented recovery path.
    await request(app).post('/api/v1/auth/password/forgot').send({ email: user.email })
    const { resetTokenFor } = await import('../factories/auth.js')
    const token = await resetTokenFor(user.email)
    await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token, password: 'a-brand-new-passphrase-9' })

    expect(await userStatus(user.id)).toBe('active')
    const after = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'a-brand-new-passphrase-9' })
    expect(after.status).toBe(200)
  })

  it('revokes existing sessions when an account is locked', async () => {
    const session = await createUserAndLogin(app)
    expect(await activeSessionCount(session.user.id)).toBe(1)

    for (let i = 0; i < env.LOGIN_MAX_FAILURES; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: session.user.email, password: `wrong-${i}` })
    }

    expect(await activeSessionCount(session.user.id)).toBe(0)
  })
})

describeIfDatabase('access token validation', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('accepts a valid token on /me', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(session.user.id)
    expect(res.body.data.sessionId).toBe(session.sessionId)
  })

  it('rejects a missing token', async () => {
    const res = await request(app).get('/api/v1/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a malformed Authorization header', async () => {
    for (const header of ['Bearer', 'Basic abc', 'token abc', '']) {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', header)
      expect(res.status).toBe(401)
    }
  })

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { sub: 'x', sid: 'y', typ: 'access' },
      'a-secret-that-is-not-ours-1234',
      {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        expiresIn: '5m',
      },
    )
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(forged))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('TOKEN_INVALID')
  })

  it('rejects an expired token with its own code', async () => {
    const user = await createUser()
    const expired = jwt.sign(
      { sub: user.id, sid: '00000000-0000-0000-0000-000000000000', roles: [], typ: 'access' },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', issuer: env.JWT_ISSUER, expiresIn: '-1s' },
    )
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(expired))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('TOKEN_EXPIRED')
  })

  it('rejects the alg:none forgery', async () => {
    const forged = jwt.sign({ sub: 'x', sid: 'y', typ: 'access' }, '', {
      algorithm: 'none',
      issuer: env.JWT_ISSUER,
    })
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(forged))
    expect(res.status).toBe(401)
  })

  it('rejects a token for a user that no longer exists', async () => {
    const session = await createUserAndLogin(app)
    await execute(`DELETE FROM users WHERE id = $1`, [session.user.id])
    usersService.clearCaches()

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session.accessToken))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_REVOKED')
  })

  it('rejects a still-valid token once the account is disabled', async () => {
    const session = await createUserAndLogin(app)
    await execute(`UPDATE users SET status = 'disabled' WHERE id = $1`, [session.user.id])
    usersService.invalidateAccess(session.user.id)

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(session.accessToken))
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('ACCOUNT_DISABLED')
  })

  it('takes roles from the database, not from the token', async () => {
    const user = await createUser({ roles: ['customer'] })
    // A token that claims owner for a user who is only a customer.
    const inflated = signAccessToken({
      userId: user.id,
      sessionId: '00000000-0000-0000-0000-000000000000',
      roles: ['owner'],
    })

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(inflated))
    expect(res.status).toBe(200)
    expect(res.body.data.roles).toEqual(['customer'])
    expect(res.body.data.permissions).toEqual([])
  })
})
