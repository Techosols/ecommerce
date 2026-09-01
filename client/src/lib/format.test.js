import { describe, expect, it } from 'vitest'
import {
  availabilityLabel,
  discountPercent,
  formatMoney,
  formatPriceRange,
  hasDiscount,
  plural,
  truncate,
} from './format'

/**
 * Money, and the ways of getting it wrong.
 *
 * Every amount is an integer of minor units carried with its currency. The
 * mistakes this suite exists to prevent are the quiet ones: dividing by a
 * hundred twice, rounding a discount up so the shop advertises a saving it
 * will not honour, and treating a missing price as zero.
 */
describe('formatMoney', () => {
  it('reads minor units as the amount a person recognises', () => {
    expect(formatMoney({ amount: 1150, currency: 'GBP' }, 'en-GB')).toBe('£11.50')
    expect(formatMoney({ amount: 5, currency: 'GBP' }, 'en-GB')).toBe('£0.05')
    expect(formatMoney({ amount: 0, currency: 'GBP' }, 'en-GB')).toBe('£0.00')
  })

  it('respects the currency it was given rather than assuming one', () => {
    expect(formatMoney({ amount: 1150, currency: 'USD' }, 'en-US')).toBe('$11.50')
    expect(formatMoney({ amount: 1150, currency: 'EUR' }, 'de-DE')).toContain('11,50')
  })

  it('shows a dash for nothing, and never a zero', () => {
    // Zero is a price. Absent is not, and the two must not look the same.
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
    expect(formatMoney({ currency: 'GBP' })).toBe('—')
  })
})

describe('formatPriceRange', () => {
  it('says "from" only when the variants actually differ', () => {
    const range = { min: { amount: 1150, currency: 'GBP' }, max: { amount: 1400, currency: 'GBP' } }
    expect(formatPriceRange(range, 'en-GB')).toBe('From £11.50')
  })

  it('gives one price when every variant costs the same', () => {
    const range = { min: { amount: 1150, currency: 'GBP' }, max: { amount: 1150, currency: 'GBP' } }
    expect(formatPriceRange(range, 'en-GB')).toBe('£11.50')
  })

  it('has an answer for a product with no purchasable variant', () => {
    // The server computes the range over purchasable variants only, so a
    // sold-out product arrives with none at all.
    expect(formatPriceRange(null)).toBe('—')
  })
})

describe('discounts', () => {
  it('recognises a real saving and ignores a fake one', () => {
    const price = { amount: 400, currency: 'GBP' }
    expect(hasDiscount(price, { amount: 500, currency: 'GBP' })).toBe(true)
    // Equal, or lower, is not a discount however it is dressed up.
    expect(hasDiscount(price, { amount: 400, currency: 'GBP' })).toBe(false)
    expect(hasDiscount(price, { amount: 300, currency: 'GBP' })).toBe(false)
    expect(hasDiscount(price, null)).toBe(false)
  })

  it('rounds a percentage down, so the shop never overstates it', () => {
    // 1/3 off is 33.3%. Advertising 34% is a promise the till will not keep.
    expect(discountPercent({ amount: 200, currency: 'GBP' }, { amount: 300, currency: 'GBP' })).toBe(33)
    expect(discountPercent({ amount: 400, currency: 'GBP' }, { amount: 500, currency: 'GBP' })).toBe(20)
    expect(discountPercent({ amount: 400, currency: 'GBP' }, null)).toBeNull()
  })
})

describe('availabilityLabel', () => {
  it('treats made-to-order as available, not as unknown', () => {
    // An item nobody counts is not an item nobody can buy.
    expect(availabilityLabel('made_to_order')).toEqual({ label: 'Made to order', tone: 'good' })
    expect(availabilityLabel('in_stock').tone).toBe('good')
    expect(availabilityLabel('low_stock').tone).toBe('warn')
    expect(availabilityLabel('out_of_stock').tone).toBe('bad')
  })

  it('fails closed on a state it does not know', () => {
    // A new state on the server must not read as "in stock" here.
    expect(availabilityLabel('something_new').tone).toBe('bad')
    expect(availabilityLabel(undefined).tone).toBe('bad')
  })
})

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('Short enough', 40)).toBe('Short enough')
  })

  it('cuts at a word boundary rather than mid-word', () => {
    const result = truncate('The quick brown fox jumps over the lazy dog', 20)
    expect(result.endsWith('…')).toBe(true)
    // Cut at the last space before the limit, not through "jumps".
    expect(result).toBe('The quick brown fox…')
  })

  it('has an answer for nothing at all', () => {
    expect(truncate(null)).toBe('')
    expect(truncate(undefined)).toBe('')
  })
})

describe('plural', () => {
  it('gets one right, which is the case everybody forgets', () => {
    expect(plural(1, 'item')).toBe('1 item')
    expect(plural(0, 'item')).toBe('0 items')
    expect(plural(3, 'item')).toBe('3 items')
    expect(plural(2, 'penny', 'pence')).toBe('2 pence')
  })
})
