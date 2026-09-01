/**
 * Staff invitations (§23.2).
 *
 * The property under test is that a staff account is unusable until the invitee
 * proves control of the mailbox *and* chooses a password nobody else has seen.
 * There is no temporary password anywhere in this flow, and the tests below
 * check that at each step: no password hash at creation, no login before
 * acceptance, and a single-use token.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import type * as QueueModule from '../../src/infrastructure/queue/index.js'
import { usersService } from '../../src/features/users/index.js'
import { invitationsService } from '../../src/features/users/users.invitations.js'
import { execute, query, queryOne } from '../../src/infrastructure/database/query.js'
import {
  DEFAULT_PASSWORD,
  bearer,
  createUser,
  createUserAndLogin,
  emailsTo,
  eventNames,
  lastEmailTo,
  tokenFromUrl,
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
const NEW_PASSWORD = 'a-brand-new-passphrase-42'

function invite(accessToken: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/admin/staff')
    .set('Authorization', bearer(accessToken))
    .send({ email: uniqueEmail('invitee'), roles: ['staff'], ...body })
}

function accept(token: string, password = NEW_PASSWORD) {
  return request(app).post('/api/v1/auth/invitation/accept').send({ token, password })
}

async function invitationTokenFor(email: string): Promise<string> {
  const message = await lastEmailTo(email)
  if (message?.template !== 'staff-invitation') {
    throw new Error(`Expected an invitation email, found ${message?.template ?? 'none'}`)
  }
  return tokenFromUrl(message.payload.acceptUrl)
}

async function credentials(userId: string) {
  return queryOne<{ password_hash: string | null; email_verified_at: Date | null; status: string }>(
    'SELECT password_hash, email_verified_at, status FROM users WHERE id = $1',
    [userId],
  )
}

describeIfDatabase('staff invitations', () => {
  let owner: Awaited<ReturnType<typeof createUserAndLogin>>

  beforeAll(setupDatabase)
  beforeEach(async () => {
    owner = await createUserAndLogin(app, { roles: ['owner'] })
  })
  afterEach(async () => {
    usersService.clearCaches()
    await truncateAll()
  })
  afterAll(teardownDatabase)

  // ── Inviting ──────────────────────────────────────────────────────────────

  it('creates a staff account with no password at all', async () => {
    const res = await invite(owner.accessToken, { firstName: 'Ada' })

    expect(res.status).toBe(201)
    expect(res.body.data.roles).toEqual(['staff'])
    expect(res.body.data.emailVerified).toBe(false)

    const row = await credentials(res.body.data.id)
    expect(row?.password_hash).toBeNull()
    expect(row?.email_verified_at).toBeNull()
  })

  it('never returns or logs anything password-shaped', async () => {
    const res = await invite(owner.accessToken)
    const body = JSON.stringify(res.body)

    expect(body).not.toMatch(/password/i)
    expect(body).not.toMatch(/\$argon2/)
    expect(body).not.toMatch(/token/i)
  })

  it('sends exactly one invitation email, carrying the only copy of the token', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })

    const messages = await emailsTo(email)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.template).toBe('staff-invitation')
    expect(messages[0]?.payload.acceptUrl).toContain('/accept-invitation?token=')

    // The event carries the token *id*, never the token itself.
    const event = await queryOne<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE name = 'staff.invited'`,
    )
    const token = tokenFromUrl(messages[0]?.payload.acceptUrl)
    expect(JSON.stringify(event?.payload)).not.toContain(token)
    expect(event?.payload.tokenId).toBeTruthy()
  })

  it('stores only a hash of the invitation token', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })
    const token = await invitationTokenFor(email)

    const rows = await query<{ token_hash: string; purpose: string }>(
      'SELECT token_hash, purpose FROM auth_tokens',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.purpose).toBe('staff_invite')
    expect(rows[0]?.token_hash).not.toBe(token)
  })

  it('records the invitation in the audit trail', async () => {
    const email = uniqueEmail('invitee')
    const res = await invite(owner.accessToken, { email, roles: ['admin'] })

    const audit = await queryOne<{
      action: string
      resource_id: string
      after: { email: string; roles: string[] }
      actor_email: string
    }>(`SELECT action, resource_id, after, actor_email FROM audit_logs ORDER BY id DESC LIMIT 1`)

    expect(audit?.action).toBe('staff.invited')
    expect(audit?.resource_id).toBe(res.body.data.id)
    expect(audit?.after.roles).toEqual(['admin'])
    expect(audit?.actor_email).toBe(owner.user.email)
  })

  it('refuses an address that already has an account', async () => {
    const existing = await createUser()
    const res = await invite(owner.accessToken, { email: existing.email })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMAIL_ALREADY_REGISTERED')
  })

  it('refuses to grant a role the inviter does not hold', async () => {
    // `staff:write` is owner-only in the seeded matrix, so an admin never
    // reaches the service. The guard is tested directly rather than through
    // HTTP, because it is the second lock on that door and must hold even if
    // the permission is ever widened.
    const admin = await createUser({ roles: ['admin'] })
    const actor = await usersService.resolveActor(admin.id, 'session-under-test')

    await expect(
      invitationsService.invite({ email: uniqueEmail('nope'), roles: ['owner'] }, actor!),
    ).rejects.toMatchObject({ code: 'ROLE_ASSIGNMENT_FORBIDDEN' })
  })

  it('refuses to invite someone as a customer — this is the staff door', async () => {
    const res = await invite(owner.accessToken, { roles: ['customer'] })
    expect(res.status).toBe(422)
  })

  it('needs staff:write, and a token', async () => {
    const admin = await createUserAndLogin(app, { roles: ['admin'] })
    const staff = await createUserAndLogin(app, { roles: ['staff'] })

    // staff:write is owner-only in the seeded matrix (§6.5).
    expect((await invite(admin.accessToken)).status).toBe(403)
    expect((await invite(staff.accessToken)).status).toBe(403)
    expect((await request(app).post('/api/v1/admin/staff').send({})).status).toBe(401)
  })

  // ── Before acceptance ─────────────────────────────────────────────────────

  it('cannot be signed into before the invitation is accepted', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD })

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('INVALID_CREDENTIALS')
  })

  it('cannot have a password set through the reset flow either', async () => {
    // Forgot-password is enumeration-safe, so it answers 202 regardless; what
    // matters is that no reset email is generated for a passwordless account.
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })

    await request(app).post('/api/v1/auth/forgot-password').send({ email })

    const templates = (await emailsTo(email)).map((m) => m.template)
    expect(templates).not.toContain('password-reset')
  })

  // ── Accepting ─────────────────────────────────────────────────────────────

  it('sets the password, verifies the address and lets the invitee log in', async () => {
    const email = uniqueEmail('invitee')
    const invited = await invite(owner.accessToken, { email })
    const token = await invitationTokenFor(email)

    const accepted = await accept(token)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toEqual({ accepted: true })
    // No session is issued here: there is exactly one login path.
    expect(accepted.headers['set-cookie']).toBeUndefined()

    const row = await credentials(invited.body.data.id)
    expect(row?.password_hash).toBeTruthy()
    expect(row?.password_hash).toMatch(/^\$argon2id\$/)
    // Clicking a link that only reached that inbox is itself proof of control.
    expect(row?.email_verified_at).not.toBeNull()

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD })
    expect(login.status).toBe(200)

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(login.body.data.accessToken))
    expect(me.body.data.roles).toEqual(['staff'])
    expect(me.body.data.isStaff).toBe(true)

    expect(await eventNames()).toContain('staff.invitation_accepted')
  })

  it('burns the token: a second acceptance fails', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })
    const token = await invitationTokenFor(email)

    expect((await accept(token)).status).toBe(200)

    // 410 Gone: the link existed and has been spent.
    const replay = await accept(token, 'yet-another-passphrase-77')
    expect(replay.status).toBe(410)
    expect(replay.body.code).toBe('LINK_EXPIRED')

    // The password the invitee chose still works; the replay changed nothing.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD })
    expect(login.status).toBe(200)
  })

  it('refuses an expired invitation', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })
    const token = await invitationTokenFor(email)

    await execute(`UPDATE auth_tokens SET expires_at = now() - interval '1 hour'`)

    expect((await accept(token)).status).toBe(410)
  })

  it('refuses a made-up token without saying which part was wrong', async () => {
    const res = await accept('A'.repeat(43))
    expect(res.status).toBe(410)
    expect(JSON.stringify(res.body)).not.toMatch(/user|account|exists/i)
  })

  it('enforces the password policy on the password being set', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })
    const token = await invitationTokenFor(email)

    const weak = await accept(token, 'password')
    expect(weak.status).toBe(422)
    expect(weak.body.code).toBe('WEAK_PASSWORD')

    // The token survives a rejected password: the invitee tries again.
    expect((await accept(token)).status).toBe(200)
  })

  it('rejects a malformed acceptance payload', async () => {
    for (const body of [{}, { token: 'x' }, { token: 'A'.repeat(43) }, { token: 'A'.repeat(43), password: NEW_PASSWORD, role: 'owner' }]) {
      const res = await request(app).post('/api/v1/auth/invitation/accept').send(body)
      expect(res.status).toBe(422)
    }
  })

  // ── Resending ─────────────────────────────────────────────────────────────

  it('resends an invitation, invalidating the previous token', async () => {
    const email = uniqueEmail('invitee')
    const invited = await invite(owner.accessToken, { email })
    const first = await invitationTokenFor(email)

    const res = await request(app)
      .post(`/api/v1/admin/staff/${invited.body.data.id}/resend-invitation`)
      .set('Authorization', bearer(owner.accessToken))
    expect(res.status).toBe(202)

    const second = await invitationTokenFor(email)
    expect(second).not.toBe(first)

    expect((await accept(first)).status).toBe(410)
    expect((await accept(second)).status).toBe(200)
  })

  it('refuses to resend to an account that has already accepted', async () => {
    const email = uniqueEmail('invitee')
    const invited = await invite(owner.accessToken, { email })
    await accept(await invitationTokenFor(email))

    const res = await request(app)
      .post(`/api/v1/admin/staff/${invited.body.data.id}/resend-invitation`)
      .set('Authorization', bearer(owner.accessToken))

    expect(res.status).toBe(422)
    expect(res.body.message).toMatch(/already been accepted/i)
  })

  it('refuses to resend to someone who is not staff', async () => {
    const customer = await createUser({ roles: ['customer'] })
    const res = await request(app)
      .post(`/api/v1/admin/staff/${customer.id}/resend-invitation`)
      .set('Authorization', bearer(owner.accessToken))

    expect(res.status).toBe(422)
  })

  it('404s for a user that does not exist', async () => {
    const res = await request(app)
      .post('/api/v1/admin/staff/00000000-0000-4000-8000-000000000000/resend-invitation')
      .set('Authorization', bearer(owner.accessToken))
    expect(res.status).toBe(404)
  })

  // ── Afterwards ────────────────────────────────────────────────────────────

  it('leaves an accepted staff member able to change their password normally', async () => {
    const email = uniqueEmail('invitee')
    await invite(owner.accessToken, { email })
    await accept(await invitationTokenFor(email))

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: NEW_PASSWORD })

    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', bearer(login.body.data.accessToken))
      .send({ currentPassword: NEW_PASSWORD, newPassword: DEFAULT_PASSWORD })

    expect(res.status).toBe(200)
  })
})
