/**
 * Shipping request schemas (§17.2). Strict throughout.
 *
 * Nothing here accepts a shipping *price* from a customer — the storefront
 * quote takes a destination and a weight and is answered with rates the server
 * computed. Prices are set by staff, on the method, once.
 */
import { z } from 'zod'
import { countryCodeField } from '../../shared/validation/common.js'

export const rateQuoteQuery = z.object({
  countryCode: countryCodeField,
  subtotalCents: z.coerce.number().int().nonnegative().default(0),
  weightGrams: z.coerce.number().int().nonnegative().max(10_000_000).default(0),
})

export const createZoneSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  countryCodes: z.array(countryCodeField).min(1).max(250),
  position: z.number().int().min(0).max(10_000).optional(),
})

/**
 * A zone patch. `countryCodes` keeps its `min(1)`: a zone covering nothing is
 * not a way to switch it off — `isActive: false` is — and an empty list would
 * leave a named zone that silently quotes nobody.
 */
export const updateZoneSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    countryCodes: z.array(countryCodeField).min(1).max(250),
    position: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
  })
  .partial()

export const zoneListQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

const rateFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).nullable().optional(),
  rateType: z.enum(['flat', 'free', 'weight_based']),
  priceCents: z.number().int().nonnegative().max(100_000_000).optional(),
  freeOverSubtotalCents: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
  minWeightGrams: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
  maxWeightGrams: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
  estimatedDaysMin: z.number().int().min(0).max(365).nullable().optional(),
  estimatedDaysMax: z.number().int().min(0).max(365).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
}

export const createMethodSchema = z
  .strictObject({ zoneId: z.uuid(), ...rateFields })
  .refine(
    (value) =>
      value.minWeightGrams == null ||
      value.maxWeightGrams == null ||
      value.minWeightGrams <= value.maxWeightGrams,
    { message: 'the minimum weight must not exceed the maximum', path: ['minWeightGrams'] },
  )

/**
 * The same cross-field rule as on create.
 *
 * Without it the database's own CHECK catches the mistake — so the data is
 * never wrong — but the client gets a generic `DOMAIN_RULE_VIOLATION` with no
 * field path, where the identical mistake on create names the offending input.
 * A form cannot highlight what to fix, so the rule is repeated here rather than
 * left to the constraint.
 *
 * The bounds are checked against the *patch*, which is the only view either
 * side has; a patch that moves only one bound is still checked by the database
 * against the stored other one.
 */
export const updateMethodSchema = z
  .strictObject({ ...rateFields, isActive: z.boolean().optional() })
  .partial()
  .refine(
    (value) =>
      value.minWeightGrams == null ||
      value.maxWeightGrams == null ||
      value.minWeightGrams <= value.maxWeightGrams,
    { message: 'the minimum weight must not exceed the maximum', path: ['minWeightGrams'] },
  )

export const zoneIdQuery = z.object({ zoneId: z.uuid().optional() })

export const idParam = z.strictObject({ id: z.uuid() })
