import { describe, expect, it } from 'vitest'
import {
  SECRET_BYTES,
  generateSecret,
  hashSecret,
  secretsMatch,
} from '../../src/shared/auth/secrets.js'
import { createActor, isStaffRoles } from '../../src/shared/auth/actor.js'

describe('opaque secrets', () => {
  it('generates a URL-safe secret with 256 bits of entropy', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(secret, 'base64url')).toHaveLength(SECRET_BYTES)
  })

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateSecret()))
    expect(seen.size).toBe(500)
  })

  it('hashes to a stable 32-byte digest', () => {
    const secret = generateSecret()
    const hash = hashSecret(secret)
    expect(hash).toHaveLength(32)
    expect(hashSecret(secret).equals(hash)).toBe(true)
  })

  it('produces a hash that does not reveal the secret', () => {
    const secret = generateSecret()
    expect(hashSecret(secret).toString('base64url')).not.toBe(secret)
  })

  it('compares digests without leaking length or content', () => {
    const a = hashSecret('one')
    expect(secretsMatch(a, hashSecret('one'))).toBe(true)
    expect(secretsMatch(a, hashSecret('two'))).toBe(false)
    expect(secretsMatch(a, Buffer.alloc(8))).toBe(false)
  })
})

describe('actor', () => {
  const base = {
    userId: 'u1',
    sessionId: 's1',
    email: 'a@example.test',
    status: 'active' as const,
    emailVerified: true,
  }

  it('answers permission questions from its own set', () => {
    const actor = createActor({
      ...base,
      roles: ['staff'],
      permissions: new Set(['orders:read']),
    })
    expect(actor.can('orders:read')).toBe(true)
    expect(actor.can('orders:refund')).toBe(false)
  })

  it('knows which roles count as staff', () => {
    expect(isStaffRoles(['staff'])).toBe(true)
    expect(isStaffRoles(['admin'])).toBe(true)
    expect(isStaffRoles(['owner'])).toBe(true)
    expect(isStaffRoles(['customer'])).toBe(false)
    expect(isStaffRoles([])).toBe(false)
  })

  it('marks a customer as not staff', () => {
    const actor = createActor({ ...base, roles: ['customer'], permissions: new Set() })
    expect(actor.isStaff).toBe(false)
    expect(actor.hasRole('customer')).toBe(true)
    expect(actor.hasRole('owner')).toBe(false)
  })
})
