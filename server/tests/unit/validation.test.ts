import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodIssuesToDetails } from '../../src/shared/middleware/validate.js'
import {
  centsField,
  emailField,
  parseSort,
  slugField,
  sortQuery,
  webUrlField,
} from '../../src/shared/validation/common.js'

describe('strict schemas', () => {
  const schema = z.strictObject({ name: z.string(), quantity: z.number().int().positive() })

  it('rejects unknown keys instead of dropping them — this is what closes mass assignment', () => {
    const result = schema.safeParse({ name: 'x', quantity: 1, role: 'admin' })
    expect(result.success).toBe(false)
    const details = zodIssuesToDetails(result.error!)
    expect(details[0]?.message).toContain('role')
  })

  it('reports a readable path for a nested failure', () => {
    const nested = z.strictObject({ address: z.strictObject({ city: z.string() }) })
    const result = nested.safeParse({ address: { city: 42 } })
    const details = zodIssuesToDetails(result.error!)
    expect(details[0]?.path).toBe('address.city')
  })
})

describe('shared field primitives', () => {
  it('normalises email to lowercase and trims it', () => {
    expect(emailField.parse('  Person@Example.COM ')).toBe('person@example.com')
  })

  it('rejects a malformed email', () => {
    expect(() => emailField.parse('not-an-email')).toThrow()
  })

  it('accepts a hyphenated slug and rejects anything else', () => {
    expect(slugField.parse('blue-cotton-shirt')).toBe('blue-cotton-shirt')
    expect(() => slugField.parse('Blue Shirt')).toThrow()
    expect(() => slugField.parse('trailing-')).toThrow()
  })

  it('accepts only integer minor units for money', () => {
    expect(centsField.parse(1999)).toBe(1999)
    expect(() => centsField.parse(19.99)).toThrow()
    expect(() => centsField.parse(-1)).toThrow()
  })
})

describe('sorting', () => {
  const allowed = ['created_at', 'total_cents'] as const
  const schema = sortQuery(allowed)

  it('accepts an allowlisted field in both directions', () => {
    expect(schema.parse({ sort: 'created_at' }).sort).toBe('created_at')
    expect(schema.parse({ sort: '-total_cents' }).sort).toBe('-total_cents')
  })

  it('rejects a field that is not allowlisted — SQL identifiers never come from input', () => {
    expect(() => schema.parse({ sort: 'password' })).toThrow()
    expect(() => schema.parse({ sort: 'created_at; DROP TABLE orders' })).toThrow()
  })

  it('parses direction and falls back safely', () => {
    expect(parseSort('-created_at', allowed, 'created_at')).toEqual({
      column: 'created_at',
      direction: 'DESC',
    })
    expect(parseSort('total_cents', allowed, 'created_at')).toEqual({
      column: 'total_cents',
      direction: 'ASC',
    })
    expect(parseSort(undefined, allowed, 'created_at')).toEqual({
      column: 'created_at',
      direction: 'DESC',
    })
  })
})

describe('webUrlField', () => {
  it('accepts ordinary http(s) URLs', () => {
    expect(webUrlField.parse('https://example.com/support')).toBe('https://example.com/support')
    expect(webUrlField.parse('  http://example.com  ')).toBe('http://example.com')
  })

  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s — this field becomes an href', (value) => {
    // z.url() alone accepts every one of these: they are well-formed URLs.
    expect(webUrlField.safeParse(value).success).toBe(false)
  })

  it('rejects things that are not URLs at all', () => {
    expect(webUrlField.safeParse('example.com').success).toBe(false)
    expect(webUrlField.safeParse('').success).toBe(false)
  })
})
