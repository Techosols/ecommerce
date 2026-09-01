/**
 * Session, credential-token and login-attempt data access (§6.3, §6.4).
 *
 * Nothing here decides policy. In particular, `markRotated` performs the
 * compare-and-swap that makes rotation safe under concurrency — but it is the
 * service that interprets a zero-row result as theft.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type { AuthTokenPurpose, SessionRecord } from './auth.types.js'

interface SessionRow {
  id: string
  user_id: string
  family_id: string
  parent_id: string | null
  user_agent: string | null
  ip: string | null
  expires_at: Date
  used_at: Date | null
  revoked_at: Date | null
  revoked_reason: string | null
  created_at: Date
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    parentId: row.parent_id,
    userAgent: row.user_agent,
    ip: row.ip,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
  }
}

export interface CreateSessionInput {
  userId: string
  familyId: string
  tokenHash: Buffer
  parentId?: string | null
  userAgent?: string | null
  ip?: string | null
  expiresAt: Date
}

export const authRepository = {
  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const id = uuidv7()
    const row = await queryOne<SessionRow>(
      `INSERT INTO sessions
         (id, user_id, family_id, refresh_token_hash, parent_id, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.userId,
        input.familyId,
        input.tokenHash,
        input.parentId ?? null,
        input.userAgent ?? null,
        input.ip ?? null,
        input.expiresAt,
      ],
      { name: 'auth.createSession' },
    )
    if (!row) throw new Error('Failed to create session')
    return toSession(row)
  },

  /**
   * Serialises every refresh for one user on the user row (§18.3).
   *
   * Without this, two concurrent refreshes of the same token can interleave so
   * that the loser's family revocation runs its scan *before* the winner's
   * successor row exists — leaving a live session descended from a token that
   * was just declared compromised. Locking the user first makes rotation and
   * revocation strictly ordered. Contention is negligible: one user refreshes
   * at most a few times an hour.
   */
  async lockUserForSessionWork(userId: string): Promise<void> {
    await query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId], {
      name: 'auth.lockUserForSessionWork',
    })
  },

  async findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | undefined> {
    const row = await queryOne<SessionRow>(
      `SELECT * FROM sessions WHERE refresh_token_hash = $1`,
      [tokenHash],
      { name: 'auth.findSessionByTokenHash' },
    )
    return row ? toSession(row) : undefined
  },

  async findSessionById(sessionId: string): Promise<SessionRecord | undefined> {
    const row = await queryOne<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [sessionId], {
      name: 'auth.findSessionById',
    })
    return row ? toSession(row) : undefined
  },

  /**
   * Compare-and-swap: claims the session for rotation only if it has not been
   * used. Zero rows means somebody already rotated it — a concurrent refresh,
   * or a stolen token being replayed (§18.3).
   */
  async markRotated(sessionId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE sessions
          SET used_at = now(), revoked_at = now(), revoked_reason = 'rotated'
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [sessionId],
      { name: 'auth.markRotated' },
    )
    return affected === 1
  },

  async revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
      { name: 'auth.revokeSession' },
    )
    return affected === 1
  },

  /** Revokes an entire rotation lineage. The response to detected theft. */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    return execute(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
      { name: 'auth.revokeFamily' },
    )
  },

  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    return execute(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [userId, reason, exceptSessionId ?? null],
      { name: 'auth.revokeAllForUser' },
    )
  },

  async listActiveSessions(userId: string): Promise<SessionRecord[]> {
    const rows = await query<SessionRow>(
      `SELECT * FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [userId],
      { name: 'auth.listActiveSessions' },
    )
    return rows.map(toSession)
  },

  // ── Credential tokens ─────────────────────────────────────────────────────

  /**
   * Issues a token, invalidating any live token of the same purpose. The
   * partial unique index makes "one live token per purpose" a storage
   * guarantee, so this consume-then-insert cannot race into two.
   */
  async createAuthToken(input: {
    userId: string
    purpose: AuthTokenPurpose
    tokenHash: Buffer
    expiresAt: Date
  }): Promise<string> {
    await execute(
      `UPDATE auth_tokens SET consumed_at = now()
        WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [input.userId, input.purpose],
      { name: 'auth.invalidatePriorTokens' },
    )

    const id = uuidv7()
    await execute(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.userId, input.purpose, input.tokenHash, input.expiresAt],
      { name: 'auth.createAuthToken' },
    )
    return id
  },

  /**
   * Single-use consumption via compare-and-swap. Returns the row only if this
   * call is the one that consumed it, so a replayed link fails cleanly.
   */
  /**
   * Reads a live token without consuming it.
   *
   * Used to answer "whose token is this, and is it still good?" *before* a
   * password is validated, so that a rejected password does not burn the one
   * link the user has. Consumption still happens exactly once, in
   * `consumeAuthToken`, which is the only thing single-use rests on.
   */
  async findActiveAuthToken(
    tokenHash: Buffer,
    purpose: AuthTokenPurpose,
  ): Promise<{ id: string; userId: string } | undefined> {
    const row = await queryOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM auth_tokens
        WHERE token_hash = $1
          AND purpose = $2
          AND consumed_at IS NULL
          AND expires_at > now()`,
      [tokenHash, purpose],
      { name: 'auth.findActiveAuthToken' },
    )
    return row ? { id: row.id, userId: row.user_id } : undefined
  },

  async consumeAuthToken(
    tokenHash: Buffer,
    purpose: AuthTokenPurpose,
  ): Promise<{ id: string; userId: string } | undefined> {
    const row = await queryOne<{ id: string; user_id: string }>(
      `UPDATE auth_tokens
          SET consumed_at = now()
        WHERE token_hash = $1
          AND purpose = $2
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING id, user_id`,
      [tokenHash, purpose],
      { name: 'auth.consumeAuthToken' },
    )
    return row ? { id: row.id, userId: row.user_id } : undefined
  },

  // ── Login attempts ────────────────────────────────────────────────────────

  async recordLoginAttempt(
    email: string | null,
    ip: string | null,
    success: boolean,
  ): Promise<void> {
    await execute(
      `INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)`,
      [email, ip, success],
      { name: 'auth.recordLoginAttempt' },
    )
  },

  /** Failures since the last success, within the window — the lockout signal. */
  async countRecentFailures(email: string, windowMinutes: number): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM login_attempts
        WHERE email = $1
          AND success = false
          AND created_at > now() - ($2 || ' minutes')::interval
          AND created_at > coalesce(
            (SELECT max(created_at) FROM login_attempts WHERE email = $1 AND success = true),
            '-infinity'::timestamptz
          )`,
      [email, windowMinutes],
      { name: 'auth.countRecentFailures' },
    )
    return row?.count ?? 0
  },

  // ── Maintenance ───────────────────────────────────────────────────────────

  async deleteExpiredSessions(): Promise<number> {
    return execute(
      `DELETE FROM sessions
        WHERE expires_at < now() - interval '30 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`,
      [],
      { name: 'auth.deleteExpiredSessions' },
    )
  },

  async deleteExpiredAuthTokens(): Promise<number> {
    return execute(
      `DELETE FROM auth_tokens
        WHERE expires_at < now() - interval '7 days'
           OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')`,
      [],
      { name: 'auth.deleteExpiredAuthTokens' },
    )
  },

  async deleteOldLoginAttempts(retentionDays: number): Promise<number> {
    return execute(
      `DELETE FROM login_attempts WHERE created_at < now() - ($1 || ' days')::interval`,
      [retentionDays],
      { name: 'auth.deleteOldLoginAttempts' },
    )
  },
}
