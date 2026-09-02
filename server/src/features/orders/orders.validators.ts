/**
 * Order and checkout request schemas (§17.2). Strict throughout.
 *
 * **Notice what checkout does not accept.** No price, no line total, no
 * subtotal, no tax, no shipping amount, no discount value, no order total. The
 * body carries an address, an email, a choice of delivery method by id and
 * possibly a discount *code*. Every figure is computed on the server from the
 * catalogue, and a strict schema is what makes sending one a 422 rather than a
 * bargain (§16.3).
 *
 * The quantities are not here either: the cart already holds them, and taking
 * them again would let the two disagree.
 */
import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'
import { countryCodeField, emailField } from '../../shared/validation/common.js'

const nameField = z.string().trim().min(1).max(100)

/**
 * The address a checkout snapshots. Shaped like the address book's, but with no
 * `id` and no `isDefault`: an order copies an address, it does not point at one,
 * so editing the address book later cannot rewrite where a parcel was sent.
 */
export const checkoutAddressSchema = z.strictObject({
  firstName: nameField,
  lastName: nameField,
  company: z.string().trim().max(120).nullable().optional().default(null),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable().optional().default(null),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).nullable().optional().default(null),
  postalCode: z.string().trim().max(20).nullable().optional().default(null),
  countryCode: countryCodeField,
  phone: z.string().trim().max(32).nullable().optional().default(null),
})

/**
 * The methods a customer may name.
 *
 * An allowlist rather than a free string, and deliberately *not* every value
 * the `payments.method` column accepts: `manual` is how staff record money that
 * arrived some other way, and offering it here would be a "mark my own order
 * paid" button. Adding a gateway later means adding its key here and to the
 * registry — the two places that decide what a customer may choose.
 *
 * Being named here is necessary but not sufficient. Whether a method is
 * actually on offer is the registry's `enabled` and `eligibility`, evaluated
 * against the store's settings and this basket — so `bank_transfer` appearing
 * in this list is what lets a customer *say* it, and the settings switch is
 * what decides whether they are allowed to.
 */
export const selectablePaymentMethod = z.enum(['cod', 'bank_transfer'])

export const checkoutSchema = z.strictObject({
  email: emailField,
  paymentMethod: selectablePaymentMethod,
  phone: z.string().trim().max(32).nullable().optional(),
  shippingAddress: checkoutAddressSchema,
  /** Omitted means "bill to the shipping address", which is the common case. */
  billingAddress: checkoutAddressSchema.optional(),
  shippingMethodId: z.uuid().nullable().optional(),
  discountCode: z.string().trim().min(1).max(64).nullable().optional(),
  customerNote: z.string().trim().max(1000).nullable().optional(),
})

export const cancelOrderSchema = z.strictObject({
  reason: z.string().trim().max(500).nullable().optional(),
  /** Staff may keep stock off the shelf — a damaged return, say. */
  restock: z.boolean().optional(),
})

export const adminNoteSchema = z.strictObject({
  note: z.string().trim().max(2000).nullable(),
})

/** One staff observation. Appended, never edited — so there is no update schema. */
export const orderNoteSchema = z.strictObject({
  body: z.string().trim().min(1).max(2000),
})

/**
 * The pinned note and the tags in one edit.
 *
 * Both optional and at least one required: a PATCH carrying neither is a
 * request that means nothing, and answering 422 says so rather than reporting
 * a successful write that changed nothing.
 */
export const annotationsSchema = z
  .strictObject({
    note: z.string().trim().max(2000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  })
  .refine((value) => value.note !== undefined || value.tags !== undefined, {
    message: 'give a note, tags, or both',
  })

/**
 * A status move names the machine and the target, never a free-form string:
 * three orthogonal fields, each with its own vocabulary (§5.6).
 */
export const transitionSchema = z.discriminatedUnion('field', [
  z.strictObject({
    field: z.literal('status'),
    to: z.enum(['confirmed', 'processing', 'completed', 'cancelled']),
    reason: z.string().trim().max(500).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  }),
  z.strictObject({
    field: z.literal('payment_status'),
    to: z.enum(['authorized', 'paid', 'failed', 'cancelled']),
    reason: z.string().trim().max(500).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  }),
  z.strictObject({
    field: z.literal('fulfillment_status'),
    to: z.enum(['partially_fulfilled', 'fulfilled', 'delivered', 'returned']),
    reason: z.string().trim().max(500).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  }),
])

export const orderListQuery = offsetPaginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['pending', 'confirmed', 'processing', 'completed', 'cancelled']).optional(),
  paymentStatus: z
    .enum(['pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled'])
    .optional(),
  fulfillmentStatus: z
    .enum(['unfulfilled', 'partially_fulfilled', 'fulfilled', 'delivered', 'returned'])
    .optional(),
  customerId: z.uuid().optional(),
  /** Repeatable: `?tags=fragile&tags=chase` narrows to orders carrying both. */
  tags: z
    .union([z.string().trim().min(1).max(40), z.array(z.string().trim().min(1).max(40)).max(10)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

/**
 * Looking up a guest order.
 *
 * Sent as a POST body rather than a query string on purpose: an email address
 * in a URL ends up in access logs, browser history and the `Referer` header of
 * every asset the resulting page loads.
 */
export const guestOrderLookupSchema = z.strictObject({
  orderNumber: z.string().trim().min(1).max(40),
  email: emailField,
})

export const myOrderListQuery = offsetPaginationQuery

export const idParam = z.strictObject({ id: z.uuid() })
export const noteParam = z.strictObject({ id: z.uuid(), noteId: z.uuid() })

/**
 * The checkout log's filters.
 *
 * `failureCode` is the server's own error code rather than free text, because
 * that is what the attempts are recorded under and what the admin groups by.
 */
export const checkoutAttemptListQuery = offsetPaginationQuery.extend({
  outcome: z.enum(['placed', 'failed']).optional(),
  failureCode: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Z_]+$/)
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

// ── Drafts ──────────────────────────────────────────────────────────────────

export const createDraftSchema = z.strictObject({
  customerId: z.uuid().nullable().optional(),
  email: emailField.optional(),
  customerNote: z.string().trim().max(1000).nullable().optional(),
})

/**
 * The whole line list, every time.
 *
 * Wholesale rather than add/remove for the same reason a discount's scope is:
 * the screen holds the list, and a diff computed in the browser against a
 * stale copy is how a line quietly disappears.
 */
export const setDraftLinesSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        variantId: z.uuid(),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .max(100),
})

export const updateDraftSchema = z
  .strictObject({
    customerId: z.uuid().nullable(),
    email: emailField,
    phone: z.string().trim().max(40).nullable(),
    paymentMethod: z.string().trim().min(1).max(40),
    shippingMethodId: z.uuid().nullable(),
    discountCode: z.string().trim().max(64).nullable(),
    customerNote: z.string().trim().max(1000).nullable(),
    shippingAddress: checkoutAddressSchema,
    billingAddress: checkoutAddressSchema,
  })
  .partial()

export const draftListQuery = offsetPaginationQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
})

export const variantSearchQuery = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().positive().max(50).default(20),
})
