/**
 * The one place the tax formula is written (§6.3).
 *
 * It had been written out three times — in the cart's totals, in checkout's
 * totals, and again per line — and a fourth caller (quoting a draft order)
 * made that a liability rather than a repetition: the inclusive branch divides
 * by `10_000 + rate` and the exclusive branch by `10_000`, and a copy that
 * drifts is a shop charging the wrong tax without anything failing.
 *
 * Pure, and takes the two settings it needs rather than the whole settings
 * object, so it can be reasoned about and tested without a database.
 */

export interface TaxBasis {
  taxRateBps: number
  pricesIncludeTax: boolean
}

/**
 * The tax contained in, or due on, an amount.
 *
 * Tax-inclusive pricing means the tax is already *inside* the amount and this
 * is how much of it is tax; exclusive means it is added on top. Getting this
 * backwards is a common and expensive mistake, so the two are separate
 * branches with names rather than one clever expression.
 */
export function taxOn(amountCents: number, settings: TaxBasis): number {
  if (settings.taxRateBps <= 0) return 0
  return settings.pricesIncludeTax
    ? Math.round((amountCents * settings.taxRateBps) / (10_000 + settings.taxRateBps))
    : Math.round((amountCents * settings.taxRateBps) / 10_000)
}

/**
 * What tax adds to a total.
 *
 * Zero under inclusive pricing — the money is already in the subtotal, and
 * adding `taxOn` to it would charge it twice. Every place that builds a total
 * wants this one, and every place that displays "of which tax" wants `taxOn`.
 */
export function taxAddedTo(amountCents: number, settings: TaxBasis): number {
  return settings.pricesIncludeTax ? 0 : taxOn(amountCents, settings)
}
