import { describe, expect, it } from 'vitest'
import { displayName, formatMoney, formatNumber, formatPercent, initialsOf } from './format'

/**
 * Display formatting.
 *
 * The money cases are the ones that matter: the API sends integer minor units,
 * and the division by 100 happens here, once, on the way into a string. A bug
 * in this file is a bug in every price the operator reads.
 */
describe('formatMoney', () => {
  it('renders minor units as a major-unit amount', () => {
    // 129950 minor units is £1,299.50 — not 129,950.
    expect(formatMoney({ amount: 129_950, currency: 'GBP' })).toMatch(/1,299\.50/)
  })

  it('handles zero-decimal currencies without inventing decimals', () => {
    expect(formatMoney({ amount: 4500, currency: 'JPY' })).toMatch(/4,500/)
    expect(formatMoney({ amount: 4500, currency: 'JPY' })).not.toMatch(/45\.00/)
  })

  it('does not throw on a currency code Intl does not recognise', () => {
    // Intl separates the code from the amount with a non-breaking space
    // (U+00A0), so the assertion normalises rather than pretending it is a
    // plain space.
    const formatted = formatMoney({ amount: 1000, currency: 'ZZZ' }).replace(/\u00a0/g, ' ')
    expect(formatted).toBe('ZZZ 10.00')
  })

  it('renders an em dash for an absent amount instead of a zero', () => {
    // A missing figure and a figure of zero mean different things on a
    // dashboard, and must not look the same.
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney({ amount: 0, currency: 'GBP' })).toMatch(/0\.00/)
  })
})

describe('formatNumber', () => {
  it('groups thousands and dashes an absent value', () => {
    expect(formatNumber(12_345)).toBe('12,345')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber(0)).toBe('0')
  })
})

describe('formatPercent', () => {
  it('always shows the sign of a change', () => {
    expect(formatPercent(12.5)).toContain('+')
    expect(formatPercent(-3)).toContain('-')
  })
})

describe('names', () => {
  it('prefers a full name and falls back to the email address', () => {
    expect(displayName({ firstName: 'Sam', lastName: 'Ops', email: 'a@b.c' })).toBe('Sam Ops')
    expect(displayName({ firstName: null, lastName: null, email: 'a@b.c' })).toBe('a@b.c')
  })

  it('builds initials from whatever is available', () => {
    expect(initialsOf('Sam', 'Ops')).toBe('SO')
    expect(initialsOf(null, null, 'ops@example.com')).toBe('O')
  })
})
