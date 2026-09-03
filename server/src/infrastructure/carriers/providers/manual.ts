import type { CarrierCapabilities, CarrierProvider } from '../provider.js'

/**
 * No courier integration at all — the shop as it works today.
 *
 * ── Why "no integration" is a provider ───────────────────────────────────────
 *
 * Because it is the honest default, and because making it a provider is what
 * proves the seam is right. Every capability is declared false, so every call
 * site falls back to exactly the behaviour that existed before couriers were
 * pluggable: staff price delivery with the shop's own rates, book the parcel on
 * the courier's own website, and paste the tracking number into the shipment
 * form.
 *
 * The alternative — a null check at each call site — puts "is a courier
 * configured?" in five places instead of one, and each of them eventually gets
 * it slightly wrong.
 *
 * This is also what a shop runs while it is deciding which courier to sign
 * with, and what it falls back to if it leaves one.
 */
export class ManualCarrierProvider implements CarrierProvider {
  readonly name = 'manual'
  readonly label = 'No courier connected'

  /**
   * All false, and therefore no methods implemented.
   *
   * The admin reads this to decide which buttons exist, so a shop on manual is
   * never offered a "Book with courier" action that cannot work.
   */
  readonly capabilities: CarrierCapabilities = {
    quotes: false,
    booking: false,
    tracking: false,
    remittance: false,
  }
}
