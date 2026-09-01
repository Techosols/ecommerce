/**
 * Analytics request schemas (§17.2). Strict throughout.
 *
 * Every range is bounded and every range is required. An unbounded "give me
 * everything" is the query that scans the whole table on the day the store is
 * busiest, so the absence of a default here is the point.
 */
import { z } from 'zod'

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')

const MAX_RANGE_DAYS = 400

export const rangeQuery = z
  .object({ from: dateField, to: dateField })
  .refine((value) => value.from <= value.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) /
        86_400_000 <=
      MAX_RANGE_DAYS,
    { message: `a range may span at most ${MAX_RANGE_DAYS} days`, path: ['to'] },
  )

export const topProductsQuery = z
  .object({
    from: dateField,
    to: dateField,
    limit: z.coerce.number().int().positive().max(100).default(10),
  })
  .refine((value) => value.from <= value.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })

/**
 * A tracked event.
 *
 * The name comes from an allowlist: an open `name` field is a table anyone can
 * fill with whatever they like, and a cardinality explosion that makes every
 * aggregate over it useless.
 */
export const trackEventSchema = z.strictObject({
  name: z.enum([
    'page_viewed',
    'product_viewed',
    'collection_viewed',
    'search_performed',
    'cart_viewed',
    'cart_item_added',
    'cart_item_removed',
    'checkout_started',
    'checkout_completed',
  ]),
  anonymousId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  occurredAt: z.iso.datetime().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Recomputing a range loops one query per day, inside the request.
 *
 * Without a ceiling, `{from: '1900-01-01'}` is forty thousand sequential round
 * trips in one HTTP call — an authenticated denial of service from a single
 * mistyped date. The same bound as every other range applies here.
 */
export const rollupSchema = z
  .strictObject({ from: dateField, to: dateField })
  .refine((value) => value.from <= value.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) /
        86_400_000 <=
      MAX_RANGE_DAYS,
    { message: `a range may span at most ${MAX_RANGE_DAYS} days`, path: ['to'] },
  )
