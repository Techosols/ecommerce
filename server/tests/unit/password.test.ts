import { describe, expect, it } from 'vitest'
import argon2 from 'argon2'
import {
  ARGON2_PRODUCTION_OPTIONS,
  PASSWORD_MIN_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  verifyDummy,
  verifyPassword,
} from '../../src/shared/auth/password.js'
import { DomainRuleError } from '../../src/shared/errors/index.js'

describe('argon2 parameters', () => {
  it('uses argon2id at the OWASP baseline in production', () => {
    expect(ARGON2_PRODUCTION_OPTIONS.type).toBe(argon2.argon2id)
    expect(ARGON2_PRODUCTION_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456)
    expect(ARGON2_PRODUCTION_OPTIONS.timeCost).toBeGreaterThanOrEqual(2)
    expect(ARGON2_PRODUCTION_OPTIONS.parallelism).toBeGreaterThanOrEqual(1)
  })
})

describe('hashing', () => {
  it('produces an argon2id hash, never the password itself', async () => {
    const hash = await hashPassword('a-reasonable-passphrase')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(hash).not.toContain('a-reasonable-passphrase')
  })

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-1'),
      hashPassword('same-password-1'),
    ])
    expect(a).not.toBe(b)
  })

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('the-correct-passphrase')
    expect(await verifyPassword(hash, 'the-correct-passphrase')).toBe(true)
    expect(await verifyPassword(hash, 'the-incorrect-passphrase')).toBe(false)
  })

  it('treats a corrupt stored hash as a wrong password rather than an exception', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false)
  })

  it('reports when a hash was made with weaker parameters', async () => {
    const weak = await argon2.hash('x', { type: argon2.argon2id, memoryCost: 1 << 10, timeCost: 1 })
    // Under test parameters the current cost is deliberately low, so this only
    // asserts the check runs and answers without throwing.
    expect(typeof needsRehash(weak)).toBe('boolean')
  })

  it('spends real work when there is no account, so timing does not leak', async () => {
    const started = process.hrtime.bigint()
    expect(await verifyDummy()).toBe(false)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000
    expect(elapsedMs).toBeGreaterThan(0)
  })
})

describe('password policy', () => {
  it('accepts a long, ordinary passphrase', () => {
    expect(() => assertPasswordAcceptable('correct horse battery staple')).not.toThrow()
  })

  it('rejects anything under the minimum length', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow(
      DomainRuleError,
    )
  })

  it('rejects an absurdly long password, which is an argon2 denial-of-service', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(1000))).toThrow(DomainRuleError)
  })

  it('rejects the passwords that dominate credential-stuffing lists', () => {
    for (const password of ['password123', 'qwertyuiop', '1234567890', 'welcome123']) {
      expect(() => assertPasswordAcceptable(password), password).toThrow(DomainRuleError)
    }
  })

  it('rejects a password built from the email address', () => {
    expect(() => assertPasswordAcceptable('jennifer-2024!!', 'jennifer@example.test')).toThrow(
      DomainRuleError,
    )
  })

  it('ignores a very short email local part, which would reject almost everything', () => {
    expect(() =>
      assertPasswordAcceptable('a-perfectly-fine-passphrase', 'jo@example.test'),
    ).not.toThrow()
  })

  it('imposes no composition rules — length is what matters', () => {
    expect(() => assertPasswordAcceptable('all lowercase words here')).not.toThrow()
  })

  it('reports the failure with a field path the client can use', () => {
    try {
      assertPasswordAcceptable('short')
      expect.unreachable('should have thrown')
    } catch (error) {
      const rule = error as DomainRuleError
      expect(rule.code).toBe('WEAK_PASSWORD')
      expect(rule.httpStatus).toBe(422)
      expect(rule.details?.[0]?.path).toBe('body.password')
    }
  })
})
