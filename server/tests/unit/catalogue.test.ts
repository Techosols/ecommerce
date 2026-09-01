/**
 * Catalogue logic that needs no database (§20.2).
 *
 * Handles, the option-combination fingerprint, and the money rules — the three
 * pieces where a subtle mistake is expensive and a unit test is cheap.
 */
import { describe, expect, it } from 'vitest'
import { assertUsableHandle, slugify } from '../../src/features/catalogue/handles.js'
import { optionSignature } from '../../src/features/catalogue/products.service.js'
import { money, resolvePrice } from '../../src/features/catalogue/pricing.js'

describe('slugify', () => {
  it('produces a readable address from a title', () => {
    expect(slugify('Classic Burger')).toBe('classic-burger')
    expect(slugify('Loaded Fries & Sides')).toBe('loaded-fries-sides')
    expect(slugify("Chef's Special #1")).toBe('chefs-special-1')
  })

  it('strips accents rather than the letters carrying them', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme')
    expect(slugify('Jalapeño Poppers')).toBe('jalapeno-poppers')
  })

  it('collapses and trims separators', () => {
    expect(slugify('  Double   --  Cheese  ')).toBe('double-cheese')
    expect(slugify('---')).toBe('')
  })

  it('returns empty for a title with nothing latin in it', () => {
    // The caller then asks for an explicit handle, rather than inventing
    // `product-a1b2c3`, which is an address nobody can read or type.
    expect(slugify('日本語')).toBe('')
  })

  it('bounds the length and does not leave a trailing hyphen', () => {
    const long = slugify(`${'word '.repeat(60)}`)
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('-')).toBe(false)
  })
})

describe('assertUsableHandle', () => {
  it('accepts a well-formed handle', () => {
    expect(() => assertUsableHandle('classic-burger')).not.toThrow()
    expect(() => assertUsableHandle('pizza-2')).not.toThrow()
  })

  it.each([
    ['uppercase', 'Classic-Burger'],
    ['a leading hyphen', '-burger'],
    ['a trailing hyphen', 'burger-'],
    ['a double hyphen', 'burger--king'],
    ['spaces', 'classic burger'],
    ['a slash — this becomes a URL path', 'burgers/classic'],
    ['a dot', 'burger.png'],
    ['empty', ''],
    ['over-long', 'a'.repeat(121)],
  ])('rejects %s', (_label, handle) => {
    expect(() => assertUsableHandle(handle)).toThrow()
  })
})

describe('optionSignature', () => {
  it('is order-independent — Size/Crust is the same variant as Crust/Size', () => {
    expect(optionSignature(['b', 'a'])).toBe(optionSignature(['a', 'b']))
  })

  it('distinguishes different combinations', () => {
    expect(optionSignature(['a', 'b'])).not.toBe(optionSignature(['a', 'c']))
  })

  it('gives a product with no options one empty signature, so it gets one variant', () => {
    // The UNIQUE (product_id, option_signature) constraint then permits exactly
    // one such variant, which is precisely the Default-variant rule.
    expect(optionSignature([])).toBe('')
  })

  it('does not collide across differing lengths', () => {
    expect(optionSignature(['ab', 'c'])).not.toBe(optionSignature(['a', 'bc']))
  })
})

describe('money', () => {
  it('always carries a currency', () => {
    expect(money(1299, 'GBP')).toEqual({ amount: 1299, currency: 'GBP' })
  })

  it('resolves a variant price into the shape a price list would also return', () => {
    expect(
      resolvePrice({ priceAmount: 599, compareAtAmount: 799, currency: 'GBP' }),
    ).toEqual({
      price: { amount: 599, currency: 'GBP' },
      compareAtPrice: { amount: 799, currency: 'GBP' },
    })
  })

  it('returns null rather than zero when there is no compare-at price', () => {
    // Zero would render as "was £0.00", which is worse than absent.
    const resolved = resolvePrice({ priceAmount: 599, compareAtAmount: null, currency: 'GBP' })
    expect(resolved.compareAtPrice).toBeNull()
  })

  it('keeps amounts as integers through the round trip', () => {
    const resolved = resolvePrice({ priceAmount: 1299, compareAtAmount: null, currency: 'USD' })
    expect(Number.isInteger(resolved.price.amount)).toBe(true)
  })
})
