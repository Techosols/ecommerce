/**
 * Human-readable money (§17.3).
 *
 * The API never sends this — over the wire money is `{ amount, currency }` in
 * integer minor units. This exists for emails and notification bodies, and it
 * is the single place where the division by 100 happens.
 */
import { describe, expect, it } from 'vitest'
import { formatMoney, minorUnitsPerMajor } from '../../src/shared/format/money.js'

describe('formatMoney', () => {
  it('renders ordinary two-decimal currencies', () => {
    expect(formatMoney(5749, 'USD', 'en-US')).toBe('$57.49')
    expect(formatMoney(0, 'USD', 'en-US')).toBe('$0.00')
  })

  it('does not lose the trailing zero', () => {
    // "$57.5" in an order confirmation looks like a bug to the person reading
    // it, because it is one.
    expect(formatMoney(5750, 'USD', 'en-US')).toBe('$57.50')
  })

  it('handles zero-decimal currencies without inventing cents', () => {
    // ¥1200 is twelve hundred yen, not twelve yen.
    expect(minorUnitsPerMajor('JPY')).toBe(1)
    expect(formatMoney(1200, 'JPY', 'en-US')).toBe('¥1,200')
  })

  it('formats an unfamiliar but well-formed ISO code by its letters', () => {
    // Intl handles any three-letter code, using the code itself as the symbol.
    // It separates code from amount with U+00A0, so the comparison normalises
    // that rather than embedding an invisible character in the expectation.
    expect(formatMoney(1234, 'XYZ', 'en-US').replace(/\u00a0/g, ' ')).toBe('XYZ 12.34')
  })

  it('falls back rather than throwing on a malformed code', () => {
    // A bad currency in the settings must not be the reason an order
    // confirmation fails to send. The money is still right; it is only plainly
    // formatted.
    expect(formatMoney(1234, 'X')).toBe('X 12.34')
    expect(formatMoney(1234, 'TOOLONG')).toBe('TOOLONG 12.34')
  })

  it('never turns a large amount into scientific notation', () => {
    expect(formatMoney(123_456_789, 'USD', 'en-US')).toBe('$1,234,567.89')
  })
})
