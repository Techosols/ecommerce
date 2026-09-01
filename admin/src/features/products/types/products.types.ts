import type { Money, OffsetQuery } from '@/types/api'

/**
 * The catalogue's admin shapes, mirrored from
 * `server/src/features/catalogue/catalogue.mapper.ts` and its validators.
 *
 * Three things about this model are load-bearing and worth stating here,
 * because the UI is built around them:
 *
 *   • **The variant is the purchasable unit.** Price, SKU, barcode and weight
 *     live on a variant, never on the product. A product with no variants is
 *     unbuyable, which is why the create schema demands at least one.
 *   • **Status and publication are separate.** `draft | active | archived` is
 *     the product's lifecycle; publication is a row per sales channel. An
 *     active product need not be published, and a published one is unpublished
 *     everywhere the moment it is archived.
 *   • **Nothing is destroyed.** Archiving is the only retirement, because an
 *     order line references a variant id for as long as the order exists.
 */

export type ProductStatus = 'draft' | 'active' | 'archived'

export interface ProductSummary {
  id: string
  handle: string
  title: string
  status: ProductStatus
  categoryId: string | null
  productType: string | null
  vendor: string | null
  tags: string[]
  /** The product's primary image, or null. Resolved by the list endpoint. */
  imageUrl: string | null
  /** Live variants — what "for 3 variants" counts in the inventory column. */
  variantCount: number
  /**
   * Units in stock across every tracked variant.
   *
   * **Null means nothing on this product is tracked**, which is not the same as
   * zero: a product nobody has ever stocked has not sold out. The two render
   * differently and must not be collapsed.
   */
  available: number | null
  createdAt: string
  updatedAt: string
}

export interface VariantOptionSelection {
  optionId: string
  name: string
  valueId: string
  value: string
}

export interface ProductVariant {
  id: string
  productId: string
  title: string
  sku: string | null
  barcode: string | null
  price: Money | null
  compareAtPrice: Money | null
  weightGrams: number
  requiresShipping: boolean
  position: number
  mediaId: string | null
  isActive: boolean
  isArchived: boolean
  options: VariantOptionSelection[]
  createdAt: string
  updatedAt: string
}

export interface ProductOptionValue {
  id: string
  value: string
  position: number
  /**
   * What this value looks like, as `#rrggbb`, or null.
   *
   * Null in two different situations that look the same here: the option is
   * not a colour at all (a size has nothing to show), and the option is a
   * colour nobody has described yet. Both render as an empty ring rather than
   * a grey dot, because a filled circle would be a claim.
   */
  swatchHex: string | null
}

export interface ProductOption {
  id: string
  name: string
  position: number
  values: ProductOptionValue[]
}

export interface ProductMedia {
  id: string
  mediaId: string
  alt: string | null
  position: number
  isPrimary: boolean
  /** `null` until the asset is `ready`; an unverified object gets no URL. */
  url: string | null
  variants: Record<string, string>
}

export interface ProductPublication {
  channel: string
  publishedAt: string
}

export interface ProductDetail {
  id: string
  handle: string
  title: string
  subtitle: string | null
  description: string | null
  status: ProductStatus
  publications: ProductPublication[]
  category: { id: string; name: string; handle: string } | null
  productType: string | null
  vendor: string | null
  tags: string[]
  seo: { title: string | null; description: string | null }
  metadata: Record<string, unknown>
  options: ProductOption[]
  variants: ProductVariant[]
  media: ProductMedia[]
  collectionIds: string[]
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

// ── Requests ────────────────────────────────────────────────────────────────

/** `{ "Size": "Large" }` — option names and values, never ids. */
export type VariantOptionInput = Record<string, string>

export interface VariantInput {
  title?: string
  sku?: string | null
  barcode?: string | null
  /** Integer minor units. `12.99` is a 422; `1299` is a price. */
  priceAmount: number
  compareAtAmount?: number | null
  weightGrams?: number
  requiresShipping?: boolean
  position?: number
  isActive?: boolean
  options?: VariantOptionInput
}

/**
 * A value on the way to the server: the bare name, or the name and its colour.
 * The union mirrors the server's own schema, so a caller with nothing to say
 * about colour keeps sending exactly what it always sent.
 */
export type OptionValueInput = string | { value: string; swatchHex?: string | null }

export interface OptionInput {
  name: string
  values: OptionValueInput[]
}

/**
 * A new axis on a product that already has variants.
 *
 * `appliesToExisting` is required by the server and is the whole reason this
 * can be done at all: every existing variant must select a value on the new
 * option, and only the merchant knows which one it should be.
 */
export interface AddOptionInput {
  name: string
  values: OptionValueInput[]
  appliesToExisting: string
}

export interface CreateProductInput {
  title: string
  handle?: string
  subtitle?: string | null
  description?: string | null
  categoryId?: string | null
  productType?: string | null
  vendor?: string | null
  tags?: string[]
  options?: OptionInput[]
  variants: VariantInput[]
  seoTitle?: string | null
  seoDescription?: string | null
}

/**
 * Every field optional, and deliberately narrower than create.
 *
 * `status`, `publications`, `variants` and `options` are absent because each
 * moves through its own endpoint — a PATCH that could archive a product would
 * hide that decision inside a form save.
 */
export interface UpdateProductInput {
  title?: string
  handle?: string
  subtitle?: string | null
  description?: string | null
  categoryId?: string | null
  productType?: string | null
  vendor?: string | null
  tags?: string[]
  seoTitle?: string | null
  seoDescription?: string | null
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

export type ProductSortKey = 'created' | 'updated' | 'title' | 'status'

export interface ProductListParams extends OffsetQuery {
  status?: ProductStatus
  categoryId?: string
  collectionId?: string
  q?: string
  sort?: ProductSortKey
  direction?: 'asc' | 'desc'
}

// ── Inventory, read on the product page ─────────────────────────────────────

/** An inventory adjustment reason, from the server's `OPERATOR_REASONS`. */
export const ADJUSTMENT_REASONS = [
  'receive',
  'manual_adjustment',
  'stocktake',
  'damage',
  'waste',
  'return',
  'correction',
] as const

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

/** From `adminInventoryItemDto`. Behind `inventory:read`, which staff hold. */
export interface VariantInventory {
  id: string
  variantId: string
  trackInventory: boolean
  lowStockThreshold: number | null
  effectiveLowStockThreshold: number
  totals: { onHand: number; reserved: number; available: number }
  isLow: boolean
  levels: Array<{
    locationId: string
    locationCode: string
    locationName: string
    onHand: number
    reserved: number
    available: number
    updatedAt: string
  }>
}
