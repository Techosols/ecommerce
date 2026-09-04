/**
 * Custom fields a shop defines for itself (§5.4).
 *
 * The vocabulary is deliberately small. Every type below is one an admin can
 * render as a single input and the server can check in a few lines — which is
 * the boundary between a feature that stays correct and one that grows a
 * validation engine nobody can reason about.
 */

export const OWNER_TYPES = ['product', 'variant', 'collection', 'customer', 'order'] as const
export type MetafieldOwnerType = (typeof OWNER_TYPES)[number]

export const METAFIELD_TYPES = [
  'single_line_text',
  'multi_line_text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'url',
  'json',
] as const
export type MetafieldType = (typeof METAFIELD_TYPES)[number]

/**
 * The bounds a definition may put on its values.
 *
 * Which of these apply depends on the type, and the service enforces only the
 * ones that make sense — `minLength` on a boolean is not an error to report, it
 * is a field that was never asked about.
 */
export interface MetafieldValidations {
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
  /** An allowed set. Turns a text field into a dropdown in the admin. */
  choices?: string[]
}

export interface MetafieldDefinition {
  id: string
  ownerType: MetafieldOwnerType
  namespace: string
  key: string
  name: string
  description: string | null
  type: MetafieldType
  validations: MetafieldValidations
  required: boolean
  storefrontVisible: boolean
  position: number
  createdAt: Date
  updatedAt: Date
}

/** A definition with however many records currently have a value for it. */
export interface MetafieldDefinitionWithUsage extends MetafieldDefinition {
  valueCount: number
}

export interface MetafieldValue {
  definitionId: string
  namespace: string
  key: string
  name: string
  type: MetafieldType
  value: unknown
  updatedAt: Date
}

/** What the storefront sees: the field and its value, and nothing about who defined it. */
export interface PublicMetafield {
  namespace: string
  key: string
  type: MetafieldType
  value: unknown
}

export interface CreateDefinitionInput {
  ownerType: MetafieldOwnerType
  namespace: string
  key: string
  name: string
  description?: string | null
  type: MetafieldType
  validations?: MetafieldValidations
  required?: boolean
  storefrontVisible?: boolean
  position?: number
}

/**
 * What may be changed after a definition exists.
 *
 * `ownerType`, `namespace`, `key` and `type` are absent on purpose: values are
 * already stored against them, and changing any one would silently reinterpret
 * data that was valid when it was written. Renaming the *label* is free, which
 * is what people actually want when they say they want to rename a field.
 */
export interface UpdateDefinitionInput {
  name?: string
  description?: string | null
  validations?: MetafieldValidations
  required?: boolean
  storefrontVisible?: boolean
  position?: number
}
