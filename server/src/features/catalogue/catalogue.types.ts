/**
 * Catalogue domain types (§5.4, docs/catalogue-model.md).
 *
 * The vocabulary is deliberate: a **product** is the conceptual item, a
 * **variant** is the only thing anyone can actually buy. Nothing here carries a
 * quantity — availability is inventory's question, and inventory does not exist
 * yet.
 */

import type { RuleSet } from './products.rules.js'

export type ProductStatus = 'draft' | 'active' | 'archived'
export type CollectionType = 'manual' | 'dynamic'

/**
 * Money crosses every boundary as an amount in minor units plus its currency.
 *
 * Never a float, and never a bare number: a bare 1299 is a bug waiting for the
 * day the store adds a second currency, and a float is a bug already.
 */
export interface Money {
  amount: number
  currency: string
}

export interface Category {
  id: string
  parentId: string | null
  name: string
  handle: string
  description: string | null
  imageId: string | null
  position: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export interface CategoryNode extends Category {
  children: CategoryNode[]
}

export interface Collection {
  id: string
  handle: string
  title: string
  description: string | null
  imageId: string | null
  type: CollectionType
  /** Conditions for a dynamic collection. Empty for a manual one. */
  rules: RuleSet
  position: number
  isActive: boolean
  seoTitle: string | null
  seoDescription: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

/**
 * An option value as a caller states it: the bare name, or the name plus what
 * it looks like. A union so every existing caller keeps compiling.
 */
export type OptionValueInput = string | { value: string; swatchHex?: string | null }

export interface ProductOptionValue {
  id: string
  optionId: string
  value: string
  position: number
  /**
   * What this value looks like, as lower-case `#rrggbb`.
   *
   * Null for options that are not colours at all — most of them — and for
   * colours nobody has described yet. It hangs off the value rather than the
   * variant because "Mulberry" is the same colour in every size.
   */
  swatchHex: string | null
}

export interface ProductOption {
  id: string
  productId: string
  name: string
  position: number
  values: ProductOptionValue[]
}

/** One variant's choice on one axis, resolved for display. */
export interface VariantSelection {
  optionId: string
  optionName: string
  optionValueId: string
  value: string
}

export interface ProductVariant {
  id: string
  productId: string
  title: string
  sku: string | null
  barcode: string | null
  price: Money
  compareAtPrice: Money | null
  weightGrams: number
  requiresShipping: boolean
  position: number
  mediaId: string | null
  isActive: boolean
  optionSignature: string
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  selections: VariantSelection[]
}

export interface ProductMedia {
  id: string
  productId: string
  mediaId: string
  alt: string | null
  position: number
  isPrimary: boolean
}

export interface Publication {
  salesChannelId: string
  channelKey: string
  publishedAt: Date
}

export interface Product {
  id: string
  handle: string
  title: string
  subtitle: string | null
  description: string | null
  status: ProductStatus
  categoryId: string | null
  productType: string | null
  vendor: string | null
  tags: string[]
  seoTitle: string | null
  seoDescription: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  createdBy: string | null
}

/** A product with everything needed to render it. One query set, one shape. */
export interface ProductDetail extends Product {
  options: ProductOption[]
  variants: ProductVariant[]
  media: ProductMedia[]
  publications: Publication[]
  category: Category | null
  collectionIds: string[]
}

export interface SalesChannel {
  id: string
  key: string
  name: string
  isDefault: boolean
  isActive: boolean
}

// ── Write shapes ────────────────────────────────────────────────────────────

export interface CreateProductInput {
  handle?: string
  title: string
  subtitle?: string | null
  description?: string | null
  categoryId?: string | null
  productType?: string | null
  vendor?: string | null
  tags?: string[]
  seoTitle?: string | null
  seoDescription?: string | null
  metadata?: Record<string, unknown>
  options?: { name: string; values: OptionValueInput[] }[]
  variants?: CreateVariantInput[]
}

export interface UpdateProductInput {
  handle?: string
  title?: string
  subtitle?: string | null
  description?: string | null
  categoryId?: string | null
  productType?: string | null
  vendor?: string | null
  tags?: string[]
  seoTitle?: string | null
  seoDescription?: string | null
  metadata?: Record<string, unknown>
}

export interface CreateVariantInput {
  title?: string
  sku?: string | null
  barcode?: string | null
  priceAmount: number
  compareAtAmount?: number | null
  currency?: string
  weightGrams?: number
  requiresShipping?: boolean
  position?: number
  isActive?: boolean
  /** `{ "Size": "Large", "Crust": "Thin" }` — names and values, not ids. */
  options?: Record<string, string>
}

export interface UpdateVariantInput {
  title?: string
  sku?: string | null
  barcode?: string | null
  priceAmount?: number
  compareAtAmount?: number | null
  weightGrams?: number
  requiresShipping?: boolean
  position?: number
  isActive?: boolean
  mediaId?: string | null
}

/**
 * The columns an admin list may be ordered by.
 *
 * A closed set rather than a free string: the value reaches an ORDER BY, and
 * the only safe way to put user input there is to never put user input there.
 * Each key maps to a fixed clause in the repository.
 */
export type ProductSortKey = 'created' | 'updated' | 'title' | 'status' | 'price'
export type SortDirection = 'asc' | 'desc'

export interface ProductListFilter {
  status?: ProductStatus
  categoryId?: string
  /** Membership of a *manual* collection, read from `collection_products`. */
  collectionId?: string
  /**
   * Membership of a *dynamic* collection, which is its rules rather than a row
   * in a join table. Takes precedence over `collectionId` when both are given,
   * because a dynamic collection has no manual membership to fall back on.
   */
  collectionRules?: RuleSet
  query?: string
  publishedOnly?: boolean
  channelKey?: string
  sort?: ProductSortKey
  direction?: SortDirection
  /**
   * Cheapest and dearest a product may be, in minor units, compared against the
   * same figure the storefront prints as "from £4.50" — the minimum over
   * purchasable variants, falling back to sellable ones when nothing is in
   * stock. Anything else would filter on a price the shopper cannot see.
   */
  minPriceAmount?: number
  maxPriceAmount?: number
  /** Only products with at least one variant somebody could buy right now. */
  inStockOnly?: boolean
  limit: number
  offset: number
}
