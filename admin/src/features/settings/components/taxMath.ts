/**
 * The tax arithmetic, kept out of the component so the two expressions below
 * are the only place in the admin that computes tax at all.
 *
 * Basis points throughout: 875 is 8.75%, integers end to end, exactly as
 * `settings.taxRateBps` carries it.
 */

/** 875 → "8.75". Trailing zeros dropped so a flat 20% is not "20.00". */
export function bpsToPercent(bps: number): string {
  return String(Number((bps / 100).toFixed(2)))
}

/** "8.75" → 875, and anything unparseable → 0 rather than NaN in a payload. */
export function percentToBps(percent: string): number {
  const value = Number(percent)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.round(value * 100)
}

/**
 * The two halves of the tax calculation, exactly as `orders.service` does them.
 *
 * Integer arithmetic on minor units, and the *same* two expressions: an example
 * that rounded differently from the server would be worse than no example, and
 * this is the only place in the admin that computes tax at all.
 */
export function taxOn(netOrGross: number, bps: number, inclusive: boolean): number {
  return inclusive
    ? Math.round((netOrGross * bps) / (10_000 + bps))
    : Math.round((netOrGross * bps) / 10_000)
}
