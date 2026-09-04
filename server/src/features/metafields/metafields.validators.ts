import { z } from 'zod'
import { METAFIELD_TYPES, OWNER_TYPES } from './metafields.types.js'

/**
 * Namespace and key are the machine identity, so they are constrained to what
 * can appear in a storefront template without quoting: lowercase, digits and
 * underscores. The same pattern the database CHECK enforces — repeated here so
 * a bad key is a field-level 422 with a path rather than a constraint violation
 * the form cannot attach to an input.
 */
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores, starting with a letter')

export const ownerTypeSchema = z.enum(OWNER_TYPES)

const validationsSchema = z
  .strictObject({
    minLength: z.number().int().nonnegative().max(65_536).optional(),
    maxLength: z.number().int().positive().max(65_536).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    choices: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .default({})

export const createDefinitionSchema = z.strictObject({
  ownerType: ownerTypeSchema,
  namespace: identifier,
  key: identifier,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  type: z.enum(METAFIELD_TYPES),
  validations: validationsSchema.optional(),
  required: z.boolean().optional(),
  storefrontVisible: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

/**
 * The patch, and what it deliberately omits.
 *
 * `ownerType`, `namespace`, `key` and `type` are absent because values are
 * stored against them. `strictObject` means sending one is a 422 that says so,
 * rather than a silently ignored field that leaves an operator believing they
 * changed a text field into a number.
 */
export const updateDefinitionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullish(),
    validations: validationsSchema.optional(),
    required: z.boolean().optional(),
    storefrontVisible: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' })

export const definitionListQuery = z.object({ ownerType: ownerTypeSchema.optional() })

export const ownerParams = z.strictObject({
  ownerType: ownerTypeSchema,
  ownerId: z.uuid(),
})

/**
 * The values a form saves.
 *
 * `value` is `unknown` on purpose: what is acceptable depends on the definition
 * this value names, and that lives in the database. The service coerces and
 * bounds it. Trying to express that here would mean building a schema per
 * definition per request.
 */
export const setValuesSchema = z.strictObject({
  values: z
    .array(z.strictObject({ definitionId: z.uuid(), value: z.unknown() }))
    .min(1)
    .max(100),
})

export const idParam = z.strictObject({ id: z.uuid() })
