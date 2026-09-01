/**
 * Human-readable money, for places a person reads rather than a program parses
 * (§17.3).
 *
 * The API never sends this — over the wire money is `{ amount, currency }` in
 * integer minor units, and a formatted string would be a lossy second
 * representation for a client to accidentally parse back. Emails and
 * notification bodies are the exception: nobody wants "your refund of 1250 GBP
 * has been issued".
 *
 * The division by 100 happens here and only here, at the last possible moment,
 * on its way into a string. No arithmetic is ever done on the result.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF'])

export function minorUnitsPerMajor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100
}

export function formatMoney(amountMinorUnits: number, currency: string, locale = 'en'): string {
  const divisor = minorUnitsPerMajor(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountMinorUnits / divisor)
  } catch {
    // An unrecognised currency code must not be the reason an order email fails
    // to send. Fall back to something correct if plain.
    const value = (amountMinorUnits / divisor).toFixed(divisor === 1 ? 0 : 2)
    return `${currency.toUpperCase()} ${value}`
  }
}
