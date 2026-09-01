/**
 * Pricing (§23.5, docs/catalogue-model.md §5).
 *
 * A deliberately thin seam with exactly one implementation today. It exists
 * because price lists, sale windows, customer-specific pricing and multiple
 * currencies all arrive as *a different answer to the same question*, and they
 * should arrive here rather than in twelve call sites.
 *
 * Two rules hold regardless of what is added later:
 *
 *   • **Money is an integer number of minor units.** No floating point touches a
 *     price, in the database, in this process, or in JSON. 0.1 + 0.2 is not 0.3,
 *     and a currency with three decimal places is not a rounding preference.
 *
 *   • **The server is the authority.** No endpoint accepts a price from a
 *     client. When carts arrive they store a variant reference and ask for the
 *     price; they do not carry one.
 */
import { settingsService } from '../settings/index.js'
import { DomainRuleError, ERROR_CODES } from '../../shared/errors/index.js'
import type { Money } from './catalogue.types.js'

/** The store's single currency, today. Multi-currency replaces this function. */
export async function storeCurrency(): Promise<string> {
  return (await settingsService.get()).currency
}

export function money(amount: number, currency: string): Money {
  return { amount, currency }
}

/**
 * Rejects a price the store cannot express.
 *
 * The currency check is what stops a variant being priced in a currency nothing
 * can charge in. It is a business rule rather than a database constraint
 * precisely because multi-currency will relax it, and relaxing a rule is easier
 * than dropping a constraint from a table with rows in it.
 */
export async function assertPriceAcceptable(input: {
  amount: number
  compareAtAmount?: number | null
  currency?: string
}): Promise<string> {
  const currency = input.currency ?? (await storeCurrency())

  if (!Number.isInteger(input.amount) || input.amount < 0) {
    throw new DomainRuleError(
      ERROR_CODES.DOMAIN_RULE_VIOLATION,
      'A price must be a whole number of minor units, and not negative',
    )
  }
  if (input.compareAtAmount != null) {
    if (!Number.isInteger(input.compareAtAmount)) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'A compare-at price must be a whole number of minor units',
      )
    }
    // A "was" price at or below the price is not a discount; it is a lie on a
    // product page, and the kind that attracts regulators.
    if (input.compareAtAmount <= input.amount) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'A compare-at price must be higher than the price',
      )
    }
  }

  const expected = await storeCurrency()
  if (currency !== expected) {
    throw new DomainRuleError(
      ERROR_CODES.DOMAIN_RULE_VIOLATION,
      `Prices must be in the store currency (${expected}) until multi-currency is supported`,
    )
  }

  return currency
}

/**
 * Resolves what a variant costs.
 *
 * Today: the price on the variant. This is the function a price list, a sale
 * window or a customer's negotiated rate would change — the shape it returns is
 * already what those would return, so nothing downstream has to change with
 * them.
 */
export function resolvePrice(variant: {
  priceAmount: number
  compareAtAmount: number | null
  currency: string
}): { price: Money; compareAtPrice: Money | null } {
  return {
    price: money(variant.priceAmount, variant.currency),
    compareAtPrice:
      variant.compareAtAmount === null ? null : money(variant.compareAtAmount, variant.currency),
  }
}
