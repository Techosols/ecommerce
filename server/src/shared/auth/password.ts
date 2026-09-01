/**
 * Password hashing and policy (§6.4).
 *
 * argon2id at the OWASP baseline: 19 MiB memory, 2 iterations, 1 lane. Memory
 * hardness is what makes a stolen hash expensive to attack on a GPU.
 *
 * The `verifyDummy` export exists for a specific reason: when a login names an
 * unknown email, we still burn a comparable amount of CPU before answering, so
 * response time does not tell an attacker which addresses are registered.
 */
import argon2 from 'argon2'
import { isTest } from '../../config/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { DomainRuleError, ERROR_CODES } from '../errors/index.js'

const log = createLogger('auth.password')

/** The OWASP baseline. What every non-test environment uses. */
export const ARGON2_PRODUCTION_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const

/**
 * Tests hash dozens of passwords per file. At production cost that is minutes
 * of pure CPU, which makes the suite too slow to run often — and a slow suite
 * is one that gets skipped. The algorithm is unchanged; only the work factor
 * is reduced, and only when NODE_ENV=test.
 */
const ARGON2_TEST_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 1 << 12,
  timeCost: 1,
  parallelism: 1,
} as const

export const ARGON2_OPTIONS = isTest ? ARGON2_TEST_OPTIONS : ARGON2_PRODUCTION_OPTIONS

export const PASSWORD_MIN_LENGTH = 10
/** Bounds the work an unauthenticated request can ask argon2 to do. */
export const PASSWORD_MAX_LENGTH = 200

/**
 * A precomputed hash of a value nobody knows, used to spend real CPU when the
 * account does not exist. Computed once at module load.
 */
let dummyHash: Promise<string> | undefined

function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash('dummy-password-for-timing-equalisation', ARGON2_OPTIONS)
  return dummyHash
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch (error) {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that would distinguish this account from any other.
    log.error({ err: error }, 'password verification failed unexpectedly')
    return false
  }
}

/** Burns comparable CPU when there is no account to verify against. */
export async function verifyDummy(): Promise<false> {
  try {
    await argon2.verify(await getDummyHash(), 'not-the-password')
  } catch {
    // Ignored by design: the point is the elapsed time, not the result.
  }
  return false
}

/** True when the stored hash was produced with weaker parameters than current. */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * The 25 passwords that dominate every credential-stuffing list, plus the
 * obvious variations on this project's own vocabulary. Length beats character
 * classes, so there are no composition rules — only a floor and a blocklist.
 */
const BLOCKED = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456789',
  '1234567890',
  '12345678',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'administrator',
  'welcome123',
  'monkey1234',
  'football12',
  'baseball12',
  'dragon1234',
  'sunshine12',
  'princess12',
  'trustno1234',
  'changeme123',
  'ecommerce123',
  'shopping123',
  'storepassword',
])

export function assertPasswordAcceptable(password: string, email?: string): void {
  const issues: { path: string; message: string }[] = []

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push({
      path: 'body.password',
      message: `must be at least ${PASSWORD_MIN_LENGTH} characters`,
    })
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push({
      path: 'body.password',
      message: `must be at most ${PASSWORD_MAX_LENGTH} characters`,
    })
  }
  if (BLOCKED.has(password.toLowerCase())) {
    issues.push({
      path: 'body.password',
      message: 'is too common; choose something less guessable',
    })
  }
  if (email) {
    const local = email.split('@')[0]?.toLowerCase()
    if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
      issues.push({ path: 'body.password', message: 'must not contain your email address' })
    }
  }

  if (issues.length > 0) {
    throw new DomainRuleError(ERROR_CODES.WEAK_PASSWORD, 'The password is not acceptable', {
      details: issues,
    })
  }
}
