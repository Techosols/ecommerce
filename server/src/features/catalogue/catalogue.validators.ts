/**
 * Catalogue request schemas (§17.2).
 *
 * Strict throughout: an unexpected field is a 422 rather than a silent drop,
 * which is what closes mass assignment (§16.3). Two catalogue-specific rules
 * are worth naming:
 *
 *   • **A price is an integer of minor units.** `z.number().int()` rejects
 *     `12.99` outright, so nobody can quietly send pounds where pence are
 *     expected — the error is at the boundary, not in a report six weeks later.
 *
 *   • **No endpoint accepts a currency, a status, a publication or a computed
 *     field.** Those move through their own transitions, not through a PATCH.
 */
import { z } from 'zod'
import { slugField } from '../../shared/validation/common.js'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'

/** Minor units. Never a float: 12.99 is a bug, 1299 is a price. */
const amountField = z
  .number()
  .int('must be a whole number of minor units, e.g. 1299 for £12.99')
  .min(0)
  .max(100_000_000)

const titleField = z.string().trim().min(1).max(200)
const handleField = slugField.max(120)
const tagField = z.string().trim().min(1).max(40)

/**
 * A colour, normalised on the way in.
 *
 * The column stores lower-case `#rrggbb` and nothing else, but a person typing
 * one has three reasonable spellings — `#FFF`, `#ffffff`, `FFFFFF` — and
 * refusing two of them teaches nothing. So the boundary is forgiving and the
 * storage is strict: shorthand is expanded, a missing hash is added, case is
 * folded, and anything still unrecognisable is refused with the shape it
 * wanted.
 */
export const swatchHexField = z
  .string()
  .trim()
  .transform((raw) => {
    const body = raw.startsWith('#') ? raw.slice(1) : raw
    const expanded =
      body.length === 3
        ? body
            .split('')
            .map((char) => char + char)
            .join('')
        : body
    return `#${expanded.toLowerCase()}`
  })
  .refine((value) => /^#[0-9a-f]{6}$/.test(value), {
    message: 'A colour must be a hex value like #b4622d',
  })

/**
 * An option value: either the bare string it has always been, or an object
 * carrying what the value looks like.
 *
 * A union rather than a breaking change, so every existing caller — the demo
 * seed, the admin's product form, the tests — keeps working untouched, and only
 * the callers that have a colour to state say so.
 */
const optionValueInput = z.union([
  z.string().trim().min(1).max(80),
  z.strictObject({
    value: z.string().trim().min(1).max(80),
    swatchHex: swatchHexField.nullable().optional(),
  }),
])

const optionInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  values: z.array(optionValueInput).min(1).max(50),
})

const variantInput = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().max(64).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  priceAmount: amountField,
  compareAtAmount: amountField.nullable().optional(),
  weightGrams: z.number().int().min(0).max(1_000_000).optional(),
  requiresShipping: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  /** `{ "Size": "Large" }` — option names and values, never ids. */
  options: z.record(z.string().min(1).max(60), z.string().min(1).max(80)).optional(),
})

export const createProductSchema = z.strictObject({
  title: titleField,
  handle: handleField.optional(),
  subtitle: z.string().trim().max(300).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  productType: z.string().trim().max(80).nullable().optional(),
  vendor: z.string().trim().max(120).nullable().optional(),
  tags: z.array(tagField).max(50).optional(),
  seoTitle: z.string().trim().max(200).nullable().optional(),
  seoDescription: z.string().trim().max(400).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  options: z.array(optionInput).max(3).optional(),
  // At least one, because only a variant is purchasable. A product with none is
  // unbuyable and looks perfectly healthy in a listing.
  variants: z.array(variantInput).min(1).max(100),
})

export const updateProductSchema = z
  .strictObject({
    title: titleField,
    handle: handleField,
    subtitle: z.string().trim().max(300).nullable(),
    description: z.string().max(20_000).nullable(),
    categoryId: z.uuid().nullable(),
    productType: z.string().trim().max(80).nullable(),
    vendor: z.string().trim().max(120).nullable(),
    tags: z.array(tagField).max(50),
    seoTitle: z.string().trim().max(200).nullable(),
    seoDescription: z.string().trim().max(400).nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial()

export const replaceOptionsSchema = z.strictObject({
  options: z.array(optionInput).max(3),
})

/**
 * One value appended to an existing option.
 *
 * Deliberately no `position`: a new value goes last, and re-ordering values is
 * not something the model needs an endpoint for yet.
 */
export const addOptionValueSchema = z.strictObject({
  value: z.string().trim().min(1).max(80),
  swatchHex: swatchHexField.nullable().optional(),
})

/**
 * A new axis on a live product.
 *
 * `appliesToExisting` is the load-bearing field and is required for that
 * reason: every variant already on the product must select a value on the new
 * option, and there is no value the server could invent on the merchant's
 * behalf. Making it optional would mean guessing.
 */
export const addOptionSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  values: z.array(optionValueInput).min(1).max(50),
  appliesToExisting: z.string().trim().min(1).max(80),
})

/**
 * Recolouring one value.
 *
 * `swatchHex` is required and nullable rather than optional: a PATCH with an
 * empty body would be a no-op the caller cannot distinguish from a successful
 * clear, and clearing a colour is a thing merchants do.
 */
export const updateOptionValueSchema = z.strictObject({
  swatchHex: swatchHexField.nullable(),
})

export const optionParam = z.strictObject({ id: z.uuid(), optionId: z.uuid() })
export const optionValueParam = z.strictObject({
  id: z.uuid(),
  optionId: z.uuid(),
  valueId: z.uuid(),
})

export const createVariantSchema = variantInput

export const updateVariantSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    sku: z.string().trim().max(64).nullable(),
    barcode: z.string().trim().max(64).nullable(),
    priceAmount: amountField,
    compareAtAmount: amountField.nullable(),
    weightGrams: z.number().int().min(0).max(1_000_000),
    requiresShipping: z.boolean(),
    position: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
    mediaId: z.uuid().nullable(),
  })
  .partial()

/** Publication names a channel; omitting it means the default storefront. */
export const publishSchema = z.strictObject({
  channel: z.string().trim().min(1).max(40).optional(),
})

export const attachMediaSchema = z.strictObject({
  mediaId: z.uuid(),
  alt: z.string().trim().max(500).nullable().optional(),
  isPrimary: z.boolean().optional(),
})

export const reorderMediaSchema = z.strictObject({
  order: z.array(z.uuid()).min(1).max(100),
  primaryId: z.uuid().optional(),
})

export const createCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  handle: handleField.optional(),
  parentId: z.uuid().nullable().optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  imageId: z.uuid().nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

export const updateCategorySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    handle: handleField,
    parentId: z.uuid().nullable(),
    description: z.string().trim().max(2_000).nullable(),
    imageId: z.uuid().nullable(),
    position: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
  })
  .partial()

/**
 * A rule set as it crosses the wire.
 *
 * `value` is `unknown` on purpose: what a value may be depends on the field,
 * and the compiler is the only place that knows. Validating it here would mean
 * a second copy of the field table, free to disagree with the first.
 */
export const collectionRulesSchema = z.strictObject({
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

export const createCollectionSchema = z.strictObject({
  type: z.enum(['manual', 'dynamic']).optional(),
  rules: collectionRulesSchema.optional(),
  title: titleField,
  handle: handleField.optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  imageId: z.uuid().nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  seoTitle: z.string().trim().max(200).nullable().optional(),
  seoDescription: z.string().trim().max(400).nullable().optional(),
  productIds: z.array(z.uuid()).max(500).optional(),
})

export const updateCollectionSchema = z
  .strictObject({
    title: titleField,
    handle: handleField,
    description: z.string().trim().max(2_000).nullable(),
    imageId: z.uuid().nullable(),
    position: z.number().int().min(0).max(10_000),
    isActive: z.boolean(),
    seoTitle: z.string().trim().max(200).nullable(),
    seoDescription: z.string().trim().max(400).nullable(),
    type: z.enum(['manual', 'dynamic']),
    rules: collectionRulesSchema,
  })
  .partial()

export const setCollectionProductsSchema = z.strictObject({
  productIds: z.array(z.uuid()).max(500),
})

/** Add and remove take at least one product; sending none is a mistake, not a no-op. */
export const collectionProductsSchema = z.strictObject({
  productIds: z.array(z.uuid()).min(1).max(500),
})

export const previewCollectionSchema = z.strictObject({ rules: collectionRulesSchema })

/**
 * A bulk change across a selection of products.
 *
 * One action per request rather than a general patch: "publish these and tag
 * them" reads as one operation to a person and is two very different failures
 * when half of it works. The action is a closed enum, so the endpoint cannot be
 * asked to do something nobody designed.
 */
export const bulkProductActionSchema = z
  .strictObject({
    productIds: z.array(z.uuid()).min(1).max(200),
    action: z.enum([
      'setStatus',
      'publish',
      'unpublish',
      'addTags',
      'removeTags',
      'addToCollection',
      'removeFromCollection',
    ]),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    channelKey: slugField.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    collectionId: z.uuid().optional(),
  })
  .refine((value) => value.action !== 'setStatus' || value.status !== undefined, {
    message: 'A status change needs a status',
    path: ['status'],
  })
  .refine(
    (value) => !['addTags', 'removeTags'].includes(value.action) || (value.tags?.length ?? 0) > 0,
    { message: 'A tag change needs at least one tag', path: ['tags'] },
  )
  .refine(
    (value) =>
      !['addToCollection', 'removeFromCollection'].includes(value.action) ||
      value.collectionId !== undefined,
    { message: 'A collection change needs a collection', path: ['collectionId'] },
  )

export const adminProductListQuery = offsetPaginationQuery.extend({
  status: z.enum(['draft', 'active', 'archived']).optional(),
  categoryId: z.uuid().optional(),
  collectionId: z.uuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
  // A closed enum, not a column name. The repository maps each key to a fixed
  // ORDER BY, so nothing a caller sends can reach the SQL. `sort` is ignored
  // when `collectionId` is set, because a collection's own order is editorial
  // content and outranks a column sort.
  sort: z.enum(['created', 'updated', 'title', 'status']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
})

/**
 * How a shopper may reorder a listing.
 *
 * A separate, smaller vocabulary from the admin's. "Newest" rather than
 * "created" because that is the word on the control, and there is no `status`
 * or `updated`: neither means anything to somebody shopping, and publishing
 * them would let a listing be ordered by a field the storefront does not show.
 */
export const STOREFRONT_SORTS = ['newest', 'price_low', 'price_high', 'title'] as const

export const storefrontProductListQuery = offsetPaginationQuery.extend({
  category: slugField.optional(),
  collection: slugField.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(STOREFRONT_SORTS).optional(),
  /**
   * Money in minor units, like every other amount that crosses this boundary.
   * A decimal here would be the one place the API took pounds, and the one
   * place a rounding error could hide.
   */
  minPrice: z.coerce.number().int().min(0).max(100_000_000).optional(),
  maxPrice: z.coerce.number().int().min(0).max(100_000_000).optional(),
  inStock: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
})

export const handleParam = z.strictObject({ handle: slugField })
export const idParam = z.strictObject({ id: z.uuid() })
export const productMediaParam = z.strictObject({ id: z.uuid(), mediaId: z.uuid() })
