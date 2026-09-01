/**
 * Customer request schemas (§17.2). Strict throughout.
 *
 * Note what a customer may NOT send about themselves: email, roles, status,
 * order counts, lifetime spend. Those are set by verified flows or by the
 * system, and a strict object is what stops them arriving in a profile PATCH
 * (§16.3).
 */
import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'
import { countryCodeField, emailField } from '../../shared/validation/common.js'
import { CUSTOMER_SORTS, MARKETING_STATES, type MarketingState } from './customers.types.js'

const nameField = z.string().trim().min(1).max(100)
const phoneField = z.string().trim().max(32).nullable()

export const addressSchema = z.strictObject({
  label: z.string().trim().max(60).nullable().optional(),
  firstName: nameField,
  lastName: nameField,
  company: z.string().trim().max(120).nullable().optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  countryCode: countryCodeField,
  phone: phoneField.optional(),
  isDefault: z.boolean().optional(),
})

export const updateAddressSchema = addressSchema.partial()

export const updateProfileSchema = z
  .strictObject({
    firstName: nameField.nullable(),
    lastName: nameField.nullable(),
    phone: phoneField,
    acceptsMarketing: z.boolean(),
  })
  .partial()

const boolish = z.enum(['true', 'false'])
const tagField = z.string().trim().min(1).max(40)

/** Repeatable, so `?tags=vip&tags=wholesale` narrows to customers with both. */
const tagsField = z
  .union([tagField, z.array(tagField).max(10)])
  .transform((value) => (Array.isArray(value) ? value : [value]))

export const customerListQuery = offsetPaginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled', 'locked']).optional(),
  hasOrders: boolish.optional(),
  acceptsMarketing: boolish.optional(),
  marketingEmailState: z.enum(MARKETING_STATES as [MarketingState, ...MarketingState[]]).optional(),
  taxExempt: boolish.optional(),
  tags: tagsField.optional(),
  // Money in minor units, like everywhere else on the wire.
  minSpent: z.coerce.number().int().min(0).optional(),
  maxSpent: z.coerce.number().int().min(0).optional(),
  minOrders: z.coerce.number().int().min(0).optional(),
  maxOrders: z.coerce.number().int().min(0).optional(),
  createdAfter: z.iso.datetime().optional(),
  createdBefore: z.iso.datetime().optional(),
  lastOrderAfter: z.iso.datetime().optional(),
  noOrderSince: z.iso.datetime().optional(),
  segmentId: z.uuid().optional(),
  sort: z.enum(CUSTOMER_SORTS as unknown as [string, ...string[]]).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
})

/** The admin's view of a customer record. Never `status` — that has its own route. */
export const createCustomerSchema = z
  .strictObject({
    email: emailField,
    firstName: nameField.nullable().optional(),
    lastName: nameField.nullable().optional(),
    phone: phoneField.optional(),
    adminNote: z.string().trim().max(2000).nullable().optional(),
    tags: z.array(tagField).max(50).optional(),
    taxExempt: z.boolean().optional(),
    locale: z.string().trim().max(20).nullable().optional(),
    marketingEmailState: z.enum(MARKETING_STATES as [MarketingState, ...MarketingState[]]).optional(),
    access: z.enum(['invite', 'password', 'none']).default('none'),
    password: z.string().min(8).max(200).optional(),
  })
  .refine((value) => value.access !== 'password' || Boolean(value.password), {
    message: 'Setting a password now needs one',
    path: ['password'],
  })

export const updateCustomerSchema = z
  .strictObject({
    firstName: nameField.nullable(),
    lastName: nameField.nullable(),
    phone: phoneField,
    adminNote: z.string().trim().max(2000).nullable(),
    taxExempt: z.boolean(),
    locale: z.string().trim().max(20).nullable(),
  })
  .partial()

export const tagsSchema = z.strictObject({
  tags: z.array(tagField).min(1).max(50),
})

export const consentSchema = z.strictObject({
  channel: z.enum(['email', 'sms']),
  state: z.enum(MARKETING_STATES as [MarketingState, ...MarketingState[]]),
  optInLevel: z.enum(['single_opt_in', 'confirmed_opt_in', 'unknown']).nullable().optional(),
})

export const customerNoteSchema = z.strictObject({
  body: z.string().trim().min(1).max(2000),
})

export const mergeSchema = z.strictObject({
  /** The record being folded in and then deleted. */
  duplicateId: z.uuid(),
})

export const eventParam = z.strictObject({ id: z.uuid(), eventId: z.uuid() })

// ── Segments ────────────────────────────────────────────────────────────────

/**
 * A rule set as it crosses the wire.
 *
 * `value` is `unknown` on purpose: what a value may be depends on the field,
 * and the compiler is the only place that knows. Validating it here would mean
 * a second copy of the field table, free to disagree with the first.
 */
export const ruleSetSchema = z.strictObject({
  match: z.enum(['all', 'any']),
  conditions: z
    .array(
      z.strictObject({
        field: z.string().trim().min(1).max(60),
        operator: z.string().trim().min(1).max(30),
        value: z.unknown().optional(),
      }),
    )
    .max(25),
})

export const createSegmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  rules: ruleSetSchema,
  isActive: z.boolean().optional(),
})

export const updateSegmentSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    rules: ruleSetSchema,
    isActive: z.boolean(),
  })
  .partial()

export const previewSegmentSchema = z.strictObject({ rules: ruleSetSchema })

export const segmentIdParam = z.strictObject({ segmentId: z.uuid() })

export const setCustomerStatusSchema = z.strictObject({
  status: z.enum(['active', 'disabled']),
})

export const idParam = z.strictObject({ id: z.uuid() })
