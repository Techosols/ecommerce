/**
 * Turning what the server sends into what a person reads.
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 *
 * Every amount in this system is an **integer of minor units** — 1150 is
 * £11.50 — carried as `{ amount, currency }`. Never a float, and never a
 * number on its own: an amount without its currency is a bug waiting for a
 * second market.
 *
 * These functions *format*. They never add, discount or convert. The storefront
 * displays prices; it does not compute them. What a basket costs is a question
 * only the server can answer, because only the server knows the discount rules,
 * the delivery rates and the tax basis.
 */

/** Formats `{ amount, currency }`. Returns an em dash for nothing at all. */
export function formatMoney(money, locale) {
  if (!money || typeof money.amount !== 'number') return '—'
  return new Intl.NumberFormat(locale ?? undefined, {
    style: 'currency',
    currency: money.currency,
  }).format(money.amount / 100)
}

/**
 * "£11.50" or "From £11.50", depending on whether the variants agree.
 *
 * The range comes from the server, computed over only the variants that can
 * actually be bought — so a product whose cheapest size is sold out shows the
 * price a shopper can pay, not the one they cannot.
 */
export function formatPriceRange(range, locale) {
  if (!range) return '—'
  const min = formatMoney(range.min, locale)
  if (range.max && range.max.amount !== range.min.amount) return `From ${min}`
  return min
}

/** True when there is a struck-through price worth showing beside the real one. */
export function hasDiscount(price, compareAtPrice) {
  return Boolean(compareAtPrice && price && compareAtPrice.amount > price.amount)
}

/** "20% off", for a sale badge. Rounded down, so it never overstates. */
export function discountPercent(price, compareAtPrice) {
  if (!hasDiscount(price, compareAtPrice)) return null
  const saved = compareAtPrice.amount - price.amount
  return Math.floor((saved / compareAtPrice.amount) * 100)
}

/**
 * What the availability state means on a shopfront.
 *
 * The server decides *whether* something can be bought; this only decides how
 * to say so. `made_to_order` is not a stock level — it is an item nobody
 * counts, which must read as available rather than as unknown.
 */
const AVAILABILITY = {
  in_stock: { label: 'In stock', tone: 'good' },
  low_stock: { label: 'Only a few left', tone: 'warn' },
  out_of_stock: { label: 'Sold out', tone: 'bad' },
  made_to_order: { label: 'Made to order', tone: 'good' },
}

export function availabilityLabel(state) {
  return AVAILABILITY[state] ?? { label: 'Unavailable', tone: 'bad' }
}

/** Trims a description to a card-sized sentence without cutting a word in half. */
export function truncate(text, limit = 120) {
  if (!text || text.length <= limit) return text ?? ''
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** "3 items" / "1 item" — the plural nobody remembers to write. */
export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}
