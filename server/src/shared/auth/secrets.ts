/**
 * Opaque secret generation and comparison (§6.2, §6.4).
 *
 * Refresh tokens, verification tokens and reset tokens are all the same shape:
 * 32 random bytes the client holds, and a SHA-256 of those bytes in the
 * database. The database never holds anything usable.
 *
 * SHA-256 rather than argon2 here is deliberate: these are 256-bit random
 * values, not user-chosen passwords, so there is nothing to brute-force and a
 * fast digest keeps the refresh path cheap.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SECRET_BYTES = 32

/** A URL-safe secret the client stores. Never persisted server-side. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/** The lookup key stored in the database. */
export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** Constant-time comparison, for the rare case we compare digests in code. */
export function secretsMatch(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
