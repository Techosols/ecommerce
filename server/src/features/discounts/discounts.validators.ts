/**
 * Discount request schemas (§17.2). Strict throughout.
 *
 * `value` carries two different units depending on `type`, which is why the
 * schema is a discriminated union rather than one object with an optional
 * field: a percentage is basis points (2500 = 25%), a fixed amount is minor
 * units. Merging them into one loosely-typed number is how a 25% code
 * eventually takes 25p.
 */
import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'

const codeField = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'a code may contain letters, numbers, hyphens and underscores')

const commonFields = {
  code: codeField,
  title: z.string().trim().min(1).max(160),
  appliesTo: z.enum(['order', 'products', 'categories']).optional(),
  minSubtotalCents: z.number().int().nonnegative().max(100_000_000).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  usageLimitTotal: z.number().int().positive().max(10_000_000).nullable().optional(),
  usageLimitPerCustomer: z.number().int().positive().max(1000).nullable().optional(),
  requiresCustomer: z.boolean().optional(),
  productIds: z.array(z.uuid()).max(500).optional(),
  categoryIds: z.array(z.uuid()).max(200).optional(),
}

export const createDiscountSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...commonFields,
      type: z.literal('percentage'),
      /** Basis points, so 10_000 is 100% and fractions of a percent survive. */
      value: z.number().int().positive().max(10_000),
    }),
    z.strictObject({
      ...commonFields,
      type: z.literal('fixed_amount'),
      value: z.number().int().positive().max(100_000_000),
    }),
    z.strictObject({
      ...commonFields,
      type: z.literal('free_shipping'),
      value: z.literal(0).optional().default(0),
    }),
  ])
  .refine(
    (value) => !value.startsAt || !value.endsAt || new Date(value.startsAt) < new Date(value.endsAt),
    { message: 'a discount must end after it starts', path: ['endsAt'] },
  )
  .refine((value) => !value.usageLimitPerCustomer || value.requiresCustomer === true, {
    message: 'a per-customer limit needs `requiresCustomer` — it cannot be counted for a guest',
    path: ['usageLimitPerCustomer'],
  })

/**
 * What may change after a code exists.
 *
 * Not the code, and not the type: an order that already cites `SUMMER25` as a
 * percentage discount must keep meaning that. Retyping a live code is a new
 * code, not an edit.
 */
export const updateDiscountSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    value: z.number().int().positive().max(100_000_000),
    // Scope is editable, unlike the code and the type: a promotion pointed at
    // the wrong category is a mistake somebody has to be able to correct, and
    // narrowing "10% off" to "10% off coffee" changes nothing about the orders
    // that already used it — those carry their own snapshot.
    appliesTo: z.enum(['order', 'products', 'categories']),
    productIds: z.array(z.uuid()).max(500),
    categoryIds: z.array(z.uuid()).max(200),
    minSubtotalCents: z.number().int().nonnegative().max(100_000_000),
    startsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime().nullable(),
    usageLimitTotal: z.number().int().positive().max(10_000_000).nullable(),
    usageLimitPerCustomer: z.number().int().positive().max(1000).nullable(),
    requiresCustomer: z.boolean(),
    isActive: z.boolean(),
  })
  .partial()
  // Repeated from create for the same reason as on a shipping method: the
  // database catches these anyway, but only as a generic rule violation with no
  // field path, and a form cannot highlight an input it was not told about.
  .refine(
    (value) => !value.startsAt || !value.endsAt || new Date(value.startsAt) < new Date(value.endsAt),
    { message: 'a discount must end after it starts', path: ['endsAt'] },
  )
  .refine((value) => value.usageLimitPerCustomer == null || value.requiresCustomer !== false, {
    message: 'a per-customer limit cannot be counted for a guest',
    path: ['usageLimitPerCustomer'],
  })

/** The storefront checks a code against a subtotal it does not get to choose. */
export const quoteDiscountSchema = z.strictObject({
  code: codeField,
})

export const discountListQuery = offsetPaginationQuery.extend({
  active: z.enum(['true', 'false']).optional(),
  /** Matches the code or the title. */
  q: z.string().trim().min(1).max(120).optional(),
  status: z
    .enum(['active', 'scheduled', 'expired', 'exhausted', 'inactive', 'archived'])
    .optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

export const idParam = z.strictObject({ id: z.uuid() })
