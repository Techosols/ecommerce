import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'
import { sanitiseRichText } from '../../shared/validation/richText.js'
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
    // Rich text, and sanitised for the same reason a product description is:
    // it renders on the checkout page, which is the last place to want somebody
    // else's script running.
    bankInstructions: z
      .string()
      .max(4_000)
      .transform((value) => sanitiseRichText(value) ?? '')
      .nullable(),

    // A short list on purpose. This is a staff distribution list, not a
    // newsletter; past a handful the right answer is a group address at the
    // mail provider rather than more rows here.
    adminNotificationEmails: z.array(z.email().max(320)).max(10),

    orderReservationHours: z.number().int().min(1).max(2160),

    logoMediaId: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial()

/**
 * The mail log's filters.
 *
 * `status` is the one that matters: "show me everything that failed" is the
 * question this screen exists to answer, and it should not require reading a
 * page of successes first.
 */
export const emailLogQuery = offsetPaginationQuery.extend({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'suppressed', 'disabled']).optional(),
  to: z.string().trim().max(320).optional(),
})

/**
 * A test message, sent by an operator to prove delivery works.
 *
 * The address is asked for rather than assumed. Sending to the store contact
 * address would prove only that the shop can mail itself — which, on a mail
 * server that delivers locally and refuses to relay, is exactly the case that
 * looks fine while every customer email is being refused.
 */
export const sendTestEmailSchema = z.strictObject({
  to: z.email().max(320),
  note: z.string().trim().max(200).optional(),
})
