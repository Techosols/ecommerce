/**
 * Shipping zones and methods, mirrored from
 * `server/src/features/shipping/shipping.service.ts`.
 *
 * Two distinctions the screens depend on:
 *
 *   • **A weight band decides whether a method is offered; a rate type decides
 *     what it costs.** They are separate fields for that reason — a method with
 *     a 0–2 kg band simply does not appear for a 3 kg parcel, which is not the
 *     same as costing nothing.
 *   • **`weight_based` prices per started kilogram.** `priceCents` means a
 *     different thing depending on `rateType`, so the form says which.
 */

export type RateType = 'flat' | 'free' | 'weight_based'

export interface ShippingZone {
  id: string
  name: string
  countryCodes: string[]
  position: number
  isActive: boolean
  isArchived: boolean
}

export interface ShippingMethod {
  id: string
  zoneId: string
  name: string
  description: string | null
  rateType: RateType
  priceCents: number
  freeOverSubtotalCents: number | null
  minWeightGrams: number | null
  maxWeightGrams: number | null
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
  position: number
  isActive: boolean
}

export interface CreateZoneInput {
  name: string
  countryCodes: string[]
  position?: number
}

export interface UpdateZoneInput {
  name?: string
  countryCodes?: string[]
  position?: number
  isActive?: boolean
}

export interface MethodInput {
  name: string
  description?: string | null
  rateType: RateType
  priceCents?: number
  freeOverSubtotalCents?: number | null
  minWeightGrams?: number | null
  maxWeightGrams?: number | null
  estimatedDaysMin?: number | null
  estimatedDaysMax?: number | null
  position?: number
  isActive?: boolean
}

export type CreateMethodInput = MethodInput & { zoneId: string }

/** What the storefront is quoted. The server computed every amount. */
export interface RateQuote {
  id: string
  name: string
  description: string | null
  price: { amount: number; currency: string }
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}
