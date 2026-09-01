/**
 * The vocabulary of a filtered listing, kept apart from the controls.
 *
 * Pure functions beside a component break fast refresh, and these are wanted by
 * the controls and by the tests that check the URL is built correctly.
 */

export const SORTS = [
  { value: '', label: 'Featured' },
  { value: 'newest', label: 'Newest' },
  { value: 'price_low', label: 'Price: low to high' },
  { value: 'price_high', label: 'Price: high to low' },
  { value: 'title', label: 'Name: A–Z' },
]

/**
 * Money in, minor units out — the only unit that crosses the API boundary.
 *
 * Returns null for anything that is not a number, so an empty box and a typo
 * both mean "no bound" rather than zero. A `maxPrice` of 0 would silently
 * empty the page.
 */
export function toMinorUnits(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export function fromMinorUnits(amount) {
  if (amount === null || amount === undefined || amount === '') return ''
  const value = Number(amount)
  return Number.isFinite(value) ? String(value / 100) : ''
}
