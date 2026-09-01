/**
 * Session listing, revocation and logout (§6.3), plus per-route rate limiting.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { env } from '../../src/config/index.js'
import { usersService } from '../../src/features/users/index.js'
import {
  activeSessionCount,
  bearer,
  createUser,
  createUserAndLogin,
  DEFAULT_PASSWORD,
  eventNames,
  login,
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

describeIfDatabase('sessions', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('lists a user’s active sessions and marks the current one', async () => {
    const user = await createUser()
    const laptop = await login(app, user.email)
    await login(app, user.email)

    const res = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(laptop.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
    expect(res.body.data.find((s: { current: boolean }) => s.current).id).toBe(laptop.sessionId)
  })

  it('never exposes a token in the session listing', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(session.accessToken))

    const body = JSON.stringify(res.body)
    expect(body).not.toContain(session.refreshToken)
    expect(body).not.toContain('refresh_token_hash')
    expect(body).not.toContain('tokenHash')
  })

  it('revokes one session by id', async () => {
    const user = await createUser()
    const laptop = await login(app, user.email)
    const phone = await login(app, user.email)

    const res = await request(app)
      .delete(`/api/v1/auth/sessions/${phone.sessionId}`)
      .set('Authorization', bearer(laptop.accessToken))

    expect(res.status).toBe(204)
    expect((await sessionRow(phone.sessionId))?.revoked_at).not.toBeNull()
    expect(await activeSessionCount(user.id)).toBe(1)
  })

  it('will not let one user revoke another user’s session', async () => {
    const attacker = await createUserAndLogin(app)
    const victim = await createUserAndLogin(app)

    const res = await request(app)
      .delete(`/api/v1/auth/sessions/${victim.sessionId}`)
      .set('Authorization', bearer(attacker.accessToken))

    // 404, not 403: confirming the session exists would itself be a leak.
    expect(res.status).toBe(404)
    expect((await sessionRow(victim.sessionId))?.revoked_at).toBeNull()
  })

  it('rejects a malformed session id', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .delete('/api/v1/auth/sessions/not-a-uuid')
      .set('Authorization', bearer(session.accessToken))
    expect(res.status).toBe(422)
  })
})

describeIfDatabase('logout', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('revokes the current session and clears the cookie', async () => {
    const session = await createUserAndLogin(app)

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', session.refreshCookie)
      .set('Authorization', bearer(session.accessToken))
      .send({})

    expect(res.status).toBe(204)
    expect((await sessionRow(session.sessionId))?.revoked_reason).toBe('logout')

    const cleared = ((res.headers as unknown as Record<string, string[]>)['set-cookie'] ?? []).find(
      (c) => c.startsWith('refresh_token='),
    )
    expect(cleared).toBeDefined()
    expect(cleared).toContain('refresh_token=;')

    const afterwards = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .send({})
    expect(afterwards.status).toBe(401)
  })

  it('works without a valid access token, so an expired client can still sign out', async () => {
    const session = await createUserAndLogin(app)

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', session.refreshCookie)
      .send({})

    expect(res.status).toBe(204)
    expect((await sessionRow(session.sessionId))?.revoked_at).not.toBeNull()
  })

  it('is harmless when there is nothing to log out of', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({})
    expect(res.status).toBe(204)
  })

  it('revokes every session on logout-all', async () => {
    const user = await createUser()
    const laptop = await login(app, user.email)
    await login(app, user.email)
    await login(app, user.email)

    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', bearer(laptop.accessToken))

    expect(res.status).toBe(200)
    expect(res.body.data.sessionsRevoked).toBe(3)
    expect(await activeSessionCount(user.id)).toBe(0)
    expect(await eventNames()).toContain('auth.logged_out')
  })

  it('requires authentication for logout-all', async () => {
    const res = await request(app).post('/api/v1/auth/logout-all')
    expect(res.status).toBe(401)
  })
})

describeIfDatabase('rate limiting on credential endpoints', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('throttles repeated login attempts against one address', async () => {
    // Limiting is off for the rest of the suite so that unrelated tests are not
    // fighting a shared counter. The `skip` predicate reads env per request, so
    // flipping it here is enough — and it is restored in a finally.
    const previous = env.RATE_LIMIT_ENABLED
    ;(env as { RATE_LIMIT_ENABLED: boolean }).RATE_LIMIT_ENABLED = true

    try {
      const email = uniqueEmail('throttled')
      const statuses: number[] = []

      for (let i = 0; i < 8; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email, password: `guess-${i}` })
        statuses.push(res.status)
      }

      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)

      const limited = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: DEFAULT_PASSWORD })
      expect(limited.status).toBe(429)
      expect(limited.body.code).toBe('RATE_LIMITED')
      expect(limited.headers['retry-after']).toBeDefined()
    } finally {
      ;(env as { RATE_LIMIT_ENABLED: boolean }).RATE_LIMIT_ENABLED = previous
    }
  })
})
