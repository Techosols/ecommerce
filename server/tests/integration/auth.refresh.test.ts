/**
 * Refresh rotation, reuse detection and session revocation (§6.3).
 *
 * This is the security core of the phase. The whole property rests on one
 * conditional UPDATE, so these tests exercise it from every angle: a normal
 * rotation, a replayed token, a revoked family, and two genuinely concurrent
 * refreshes racing on the same row.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { execute, query } from '../../src/infrastructure/database/query.js'
import {
  activeSessionCount,
  bearer,
  createUser,
  createUserAndLogin,
  eventNames,
  refreshCookieFrom,
  sessionRow,
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

function refresh(cookie: string) {
  return request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).send({})
}

describeIfDatabase('refresh token rotation', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('exchanges a refresh token for a new access token and a new refresh token', async () => {
    const session = await createUserAndLogin(app)

    const res = await refresh(session.refreshCookie)
    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.accessToken).not.toBe(session.accessToken)

    const rotated = refreshCookieFrom(res.headers as Record<string, unknown>)
    expect(rotated).not.toBe(session.refreshCookie)
  })

  it('marks the old session rotated and issues a successor in the same family', async () => {
    const session = await createUserAndLogin(app)
    const res = await refresh(session.refreshCookie)

    const old = await sessionRow(session.sessionId)
    expect(old?.used_at).not.toBeNull()
    expect(old?.revoked_reason).toBe('rotated')

    const successor = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(res.body.data.accessToken as string))
    expect(successor.status).toBe(200)

    const rows = await query<{ family_id: string; parent_id: string | null }>(
      `SELECT family_id, parent_id FROM sessions WHERE user_id = $1 ORDER BY created_at`,
      [session.user.id],
    )
    expect(rows).toHaveLength(2)
    expect(rows[1]?.family_id).toBe(rows[0]?.family_id)
    expect(rows[1]?.parent_id).toBe(session.sessionId)
  })

  it('accepts the refresh token from the request body, for clients without a cookie jar', async () => {
    const session = await createUserAndLogin(app)
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
    expect(res.status).toBe(200)
  })

  it('rotates repeatedly, keeping exactly one live session', async () => {
    const session = await createUserAndLogin(app)
    let cookie = session.refreshCookie

    for (let i = 0; i < 4; i++) {
      const res = await refresh(cookie)
      expect(res.status).toBe(200)
      cookie = refreshCookieFrom(res.headers as Record<string, unknown>)
    }

    expect(await activeSessionCount(session.user.id)).toBe(1)
  })

  it('rejects a refresh token that was never issued', async () => {
    const res = await refresh(`refresh_token=${'A'.repeat(43)}`)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('REFRESH_TOKEN_INVALID')
  })

  it('requires a refresh token to be present at all', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({})
    expect(res.status).toBe(422)
  })

  it('rejects an expired refresh token', async () => {
    const session = await createUserAndLogin(app)
    await execute(`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = $1`, [
      session.sessionId,
    ])

    const res = await refresh(session.refreshCookie)
    expect(res.status).toBe(401)
    expect((await sessionRow(session.sessionId))?.revoked_reason).toBe('expired')
  })

  it('refuses to refresh once the account is disabled, and kills the family', async () => {
    const session = await createUserAndLogin(app)
    await execute(`UPDATE users SET status = 'disabled' WHERE id = $1`, [session.user.id])
    usersService.invalidateAccess(session.user.id)

    const res = await refresh(session.refreshCookie)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('ACCOUNT_DISABLED')
    expect(await activeSessionCount(session.user.id)).toBe(0)
  })
})

describeIfDatabase('refresh token reuse detection', () => {
  beforeAll(setupDatabase)
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  it('treats a replayed token as theft and revokes the whole family', async () => {
    const session = await createUserAndLogin(app)

    // Legitimate rotation.
    const first = await refresh(session.refreshCookie)
    expect(first.status).toBe(200)
    const rotatedCookie = refreshCookieFrom(first.headers as Record<string, unknown>)

    // The attacker replays the token they stole before the rotation.
    const replay = await refresh(session.refreshCookie)
    expect(replay.status).toBe(401)
    expect(replay.body.code).toBe('SESSION_REVOKED')

    // The legitimate successor is dead too — that is the point. Better to log
    // the real user out than to leave the thief with a working session.
    const afterwards = await refresh(rotatedCookie)
    expect(afterwards.status).toBe(401)

    expect(await activeSessionCount(session.user.id)).toBe(0)
    expect(await eventNames()).toContain('auth.token_reuse_detected')
  })

  it('records why every session in the family died', async () => {
    const session = await createUserAndLogin(app)
    await refresh(session.refreshCookie)
    await refresh(session.refreshCookie)

    const rows = await query<{ revoked_reason: string }>(
      `SELECT revoked_reason FROM sessions WHERE user_id = $1`,
      [session.user.id],
    )
    expect(rows.some((r) => r.revoked_reason === 'reuse_detected')).toBe(true)
  })

  it('leaves other families alone — only the compromised lineage is revoked', async () => {
    const user = await createUser()
    const { login } = await import('../factories/auth.js')

    const laptop = await login(app, user.email)
    const phone = await login(app, user.email)

    await refresh(laptop.refreshCookie)
    const replay = await refresh(laptop.refreshCookie)
    expect(replay.status).toBe(401)

    // The phone's independent family is untouched.
    const phoneRefresh = await refresh(phone.refreshCookie)
    expect(phoneRefresh.status).toBe(200)
  })

  it('rejects a token from a family revoked by logout-all', async () => {
    const session = await createUserAndLogin(app)
    await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', bearer(session.accessToken))

    const res = await refresh(session.refreshCookie)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_REVOKED')
  })

  it('lets exactly one of several concurrent refreshes win, and kills the family', async () => {
    // Two tabs refreshing at the same instant is indistinguishable, server-side,
    // from a stolen token being replayed. The safe reading is theft.
    const session = await createUserAndLogin(app)

    const results = await Promise.all([
      refresh(session.refreshCookie),
      refresh(session.refreshCookie),
      refresh(session.refreshCookie),
    ])

    const succeeded = results.filter((r) => r.status === 200)
    const rejected = results.filter((r) => r.status === 401)

    expect(succeeded).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    expect(rejected.every((r) => r.body.code === 'SESSION_REVOKED')).toBe(true)

    // The winner is revoked too, because the family was torn down after it.
    expect(await activeSessionCount(session.user.id)).toBe(0)
  })

  it('never lets two refreshes both mint a session from one token', async () => {
    const session = await createUserAndLogin(app)

    await Promise.all([refresh(session.refreshCookie), refresh(session.refreshCookie)])

    const rows = await query<{ parent_id: string | null }>(
      `SELECT parent_id FROM sessions WHERE parent_id = $1`,
      [session.sessionId],
    )
    // At most one successor may ever descend from a single token.
    expect(rows.length).toBeLessThanOrEqual(1)
  })
})
