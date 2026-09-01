/**
 * Fixtures for the auth suites (§20.3).
 *
 * Users are created through the real service so that schema drift breaks the
 * factory rather than fifty tests. Tokens are read out of `email_messages` —
 * the same place a real recipient would get them from — which keeps the tests
 * honest about the fact that verification and reset tokens only ever exist in
 * the message.
 */
import type { Express } from 'express'
import request from 'supertest'
import { execute, queryOne } from '../../src/infrastructure/database/query.js'
import { usersService } from '../../src/features/users/index.js'
import { hashPassword } from '../../src/shared/auth/password.js'
import type { UserStatus } from '../../src/features/users/index.js'
import { REFRESH_COOKIE_NAME } from '../../src/features/auth/auth.cookies.js'

export const DEFAULT_PASSWORD = 'correct-horse-battery-staple'

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}@example.test`
}

export interface CreatedUser {
  id: string
  email: string
  password: string
  roles: string[]
}

/** Creates a user directly, bypassing registration. */
export async function createUser(
  options: {
    email?: string
    password?: string | null
    roles?: string[]
    status?: UserStatus
    emailVerified?: boolean
    firstName?: string
  } = {},
): Promise<CreatedUser> {
  const email = options.email ?? uniqueEmail()
  const password = options.password === null ? null : (options.password ?? DEFAULT_PASSWORD)
  const roles = options.roles ?? ['customer']

  const user = await usersService.create({
    email,
    passwordHash: password === null ? null : await hashPassword(password),
    firstName: options.firstName ?? null,
    roles,
  })

  if (options.emailVerified !== false) {
    await execute(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [user.id])
  }
  if (options.status && options.status !== 'active') {
    await execute(`UPDATE users SET status = $2 WHERE id = $1`, [user.id, options.status])
  }
  usersService.invalidateAccess(user.id)

  return { id: user.id, email, password: password ?? '', roles }
}

export interface LoggedIn {
  user: CreatedUser
  accessToken: string
  refreshToken: string
  refreshCookie: string
  sessionId: string
}

/** Extracts the refresh cookie value from a Set-Cookie header list. */
export function refreshCookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie']
  const cookies = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : []
  const cookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`))
  if (!cookie) throw new Error('No refresh cookie in response')
  return cookie.split(';')[0] ?? ''
}

export function refreshTokenFrom(headers: Record<string, unknown>): string {
  return refreshCookieFrom(headers).split('=').slice(1).join('=')
}

/** Logs in over HTTP and returns everything a follow-up request needs. */
export async function login(
  app: Express,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<Omit<LoggedIn, 'user'>> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password })
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return {
    accessToken: res.body.data.accessToken as string,
    refreshToken: refreshTokenFrom(res.headers as Record<string, unknown>),
    refreshCookie: refreshCookieFrom(res.headers as Record<string, unknown>),
    sessionId: res.body.data.user.sessionId as string,
  }
}

export async function createUserAndLogin(
  app: Express,
  options: Parameters<typeof createUser>[0] = {},
): Promise<LoggedIn> {
  const user = await createUser(options)
  const session = await login(app, user.email, user.password)
  return { user, ...session }
}

export function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`
}

// ── Reading what was mailed ─────────────────────────────────────────────────

export interface QueuedEmail {
  id: string
  template: string
  toEmail: string
  payload: Record<string, unknown>
}

export async function lastEmailTo(email: string): Promise<QueuedEmail | undefined> {
  const row = await queryOne<{
    id: string
    template: string
    to_email: string
    payload: Record<string, unknown>
  }>(
    `SELECT id, template, to_email, payload FROM email_messages
      WHERE to_email = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [email.toLowerCase()],
  )
  return row
    ? { id: row.id, template: row.template, toEmail: row.to_email, payload: row.payload }
    : undefined
}

export async function emailsTo(email: string): Promise<QueuedEmail[]> {
  const { query } = await import('../../src/infrastructure/database/query.js')
  const rows = await query<{
    id: string
    template: string
    to_email: string
    payload: Record<string, unknown>
  }>(
    `SELECT id, template, to_email, payload FROM email_messages
      WHERE to_email = $1 ORDER BY created_at, id`,
    [email.toLowerCase()],
  )
  return rows.map((row) => ({
    id: row.id,
    template: row.template,
    toEmail: row.to_email,
    payload: row.payload,
  }))
}

/** Pulls the one-time token out of a link in a queued email. */
export function tokenFromUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error(`Expected a URL, got ${typeof url}`)
  const token = new URL(url).searchParams.get('token')
  if (!token) throw new Error(`No token in ${url}`)
  return token
}

export async function verificationTokenFor(email: string): Promise<string> {
  const message = await lastEmailTo(email)
  if (message?.template !== 'email-verification') {
    throw new Error(`Expected a verification email, found ${message?.template ?? 'none'}`)
  }
  return tokenFromUrl(message.payload.verificationUrl)
}

export async function resetTokenFor(email: string): Promise<string> {
  const message = await lastEmailTo(email)
  if (message?.template !== 'password-reset') {
    throw new Error(`Expected a reset email, found ${message?.template ?? 'none'}`)
  }
  return tokenFromUrl(message.payload.resetUrl)
}

// ── Session inspection ──────────────────────────────────────────────────────

export async function sessionRow(sessionId: string) {
  return queryOne<{
    id: string
    revoked_at: Date | null
    revoked_reason: string | null
    used_at: Date | null
    family_id: string
  }>(`SELECT id, revoked_at, revoked_reason, used_at, family_id FROM sessions WHERE id = $1`, [
    sessionId,
  ])
}

export async function activeSessionCount(userId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [userId],
  )
  return row?.count ?? 0
}

export async function userStatus(userId: string): Promise<string | undefined> {
  const row = await queryOne<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId])
  return row?.status
}

export async function eventNames(): Promise<string[]> {
  const { query } = await import('../../src/infrastructure/database/query.js')
  const rows = await query<{ name: string }>(`SELECT name FROM domain_events ORDER BY id`)
  return rows.map((r) => r.name)
}
