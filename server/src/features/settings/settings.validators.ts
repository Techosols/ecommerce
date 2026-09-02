import { z } from 'zod'
import { countryCodeField, emailField, webUrlField } from '../../shared/validation/common.js'

/**
 * A strict, fully optional patch: an unknown key is a 422 rather than a silent
 * drop, and a caller cannot write `updatedBy`, `id` or anything else the
 * repository's column allowlist does not carry (§16.3).
 */
export const updateSettingsSchema = z
  .strictObject({
    storeName: z.string().trim().min(1).max(120),
    contactEmail: emailField,
    // http(s) only: this URL becomes a link on the storefront (see webUrlField).
    supportUrl: webUrlField.nullable(),
    supportPhone: z.string().trim().max(40).nullable(),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code'),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => {
          // The IANA database is the authority; ask the platform rather than
          // shipping a list that goes stale.
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: value })
            return true
          } catch {
            return false
          }
        },
        { message: 'must be a valid IANA time zone, e.g. Europe/London' },
      ),
    weightUnit: z.enum(['g', 'kg', 'lb', 'oz']),
    taxRateBps: z.number().int().min(0).max(10_000),
    pricesIncludeTax: z.boolean(),
    defaultLowStockThreshold: z.number().int().min(0).max(100_000),
    orderNumberPrefix: z.string().max(8),
    reservationTtlMinutes: z.number().int().min(1).max(43_200),
    guestCheckoutEnabled: z.boolean(),

    // Cash on delivery policy. The ordering rule (min <= max) is enforced by a
    // database CHECK as well, because a patch may set either one alone and only
    // the database sees both the old and the new value.
    codEnabled: z.boolean(),
    codMinSubtotalCents: z.number().int().min(0).max(100_000_000),
    codMaxSubtotalCents: z.number().int().min(0).max(100_000_000).nullable(),
    codFeeCents: z.number().int().min(0).max(1_000_000),
    codCountryCodes: z.array(countryCodeField).max(250),
    codRequiresAccount: z.boolean(),
    codMaxOpenOrders: z.number().int().min(1).max(1000).nullable(),

    // Bank transfer. The rule that matters — enabled implies an account to pay
    // into — is a database CHECK for the same reason the COD range is: a patch
    // may set the switch alone, and only the database sees both the old and the
    // new value. A 422 from here would need the current row to be right, and
    // would still be racing another patch.
    bankTransferEnabled: z.boolean(),
    bankAccountName: z.string().trim().max(120).nullable(),
    bankName: z.string().trim().max(120).nullable(),
    bankAccountNumber: z.string().trim().max(64).nullable(),
    bankIban: z.string().trim().max(64).nullable(),
    bankSwift: z.string().trim().max(16).nullable(),
    bankInstructions: z.string().trim().max(1000).nullable(),

    orderReservationHours: z.number().int().min(1).max(2160),

    logoMediaId: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial()
