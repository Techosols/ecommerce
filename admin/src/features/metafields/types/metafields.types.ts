/**
 * Custom fields, as the server publishes them.
 *
 * Every shape here mirrors `metafields.admin.routes.ts`. Nothing in the admin
 * decides what a field means: which fields exist, what type each is, what it
 * will accept and whether customers may see it are all the server's answers,
 * read here to decide what to render.
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

export interface MetafieldValidations {
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
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
  createdAt: string
  updatedAt: string
  /** How many records currently have a value. The number a delete must name. */
  valueCount: number
}

/** A field on one record: the definition it comes from, and this record's value. */
export interface MetafieldEntry {
  definitionId: string
  namespace: string
  key: string
  name: string
  description: string | null
  type: MetafieldType
  validations: MetafieldValidations
  required: boolean
  storefrontVisible: boolean
  value: unknown
  updatedAt: string
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
 * What a definition patch may carry.
 *
 * No `type`, `namespace`, `key` or `ownerType` — values are already stored
 * against them, and the server refuses the field outright rather than
 * pretending a text column can become a number.
 */
export interface UpdateDefinitionInput {
  name?: string
  description?: string | null
  validations?: MetafieldValidations
  required?: boolean
  storefrontVisible?: boolean
  position?: number
}

export const TYPE_LABELS: Record<MetafieldType, string> = {
  single_line_text: 'Text',
  multi_line_text: 'Long text',
  integer: 'Whole number',
  decimal: 'Decimal number',
  boolean: 'True or false',
  date: 'Date',
  url: 'Link',
  json: 'JSON',
}

export const OWNER_LABELS: Record<MetafieldOwnerType, string> = {
  product: 'Products',
  variant: 'Variants',
  collection: 'Collections',
  customer: 'Customers',
  order: 'Orders',
}
