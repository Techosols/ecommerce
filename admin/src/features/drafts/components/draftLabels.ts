import type { DraftAddress, DraftDetail, DraftShippingOption } from '../types/drafts.types'

/**
 * Wording for the draft screens.
 *
 * A separate module because these are pure functions, and exporting them
 * beside a component breaks fast refresh — the same reason the other features
 * keep their labels apart.
 */

/** The state of a draft, as one word a person would use. */
export function draftState(draft: {
  placedOrderId: string | null
}): { label: string; tone: 'positive' | 'info' } {
  return draft.placedOrderId
    ? { label: 'Placed', tone: 'positive' }
    : { label: 'Being built', tone: 'info' }
}

/** An address on one line, for a summary. */
export function addressLine(address: DraftAddress): string {
  return [
    `${address.firstName} ${address.lastName}`.trim(),
    address.company,
    address.line1,
    address.line2,
    address.city,
    address.region,
    address.postalCode,
    address.countryCode,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(', ')
}

/** "2–4 days", or nothing when the carrier has not said. */
export function deliveryEstimate(option: DraftShippingOption): string | null {
  const { estimatedDaysMin: min, estimatedDaysMax: max } = option
  if (min === null && max === null) return null
  if (min !== null && max !== null) {
    return min === max ? `${min} day${min === 1 ? '' : 's'}` : `${min}–${max} days`
  }
  const known = (min ?? max) as number
  return `${known} day${known === 1 ? '' : 's'}`
}

/**
 * Whether this draft can be placed.
 *
 * Reads the server's own answer rather than re-deriving it. The admin has no
 * business deciding an order is complete — it can only report what it was
 * told, and a check written here would be a second rule free to disagree with
 * the one that actually governs placement.
 */
export function isReady(draft: DraftDetail): boolean {
  return draft.blockers.length === 0 && draft.placedOrderId === null
}

/** The subject of a draft, for a heading. */
export function draftTitle(draft: { email: string | null; reference: string }): string {
  return draft.email || draft.reference
}
