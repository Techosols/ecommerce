import type { ProductVariant, UpdateVariantInput } from '../types/products.types'

/**
 * Every field `updateVariantSchema` accepts, as form state.
 *
 * The form holds `''` where the API holds `null`, because an input cannot hold
 * `null`; `toVariantPatch` converts back on the way out. `weightGrams` is a
 * string for the same reason — a number input mid-edit is legitimately empty.
 */
export interface VariantFormValues extends Record<string, unknown> {
  title: string
  priceAmount: number | null
  compareAtAmount: number | null
  sku: string
  barcode: string
  weightGrams: string
  requiresShipping: boolean
  isActive: boolean
  mediaId: string
}

export function toVariantFormValues(variant: ProductVariant): VariantFormValues {
  return {
    title: variant.title,
    priceAmount: variant.price?.amount ?? null,
    compareAtAmount: variant.compareAtPrice?.amount ?? null,
    sku: variant.sku ?? '',
    barcode: variant.barcode ?? '',
    weightGrams: String(variant.weightGrams),
    requiresShipping: variant.requiresShipping,
    isActive: variant.isActive,
    mediaId: variant.mediaId ?? '',
  }
}

/**
 * The dirty keys, as the PATCH body the server accepts.
 *
 * Only what changed: a body carrying every field would resend values nobody
 * touched, and would overwrite a colleague's concurrent edit with stale data.
 */
export function toVariantPatch(dirty: Partial<VariantFormValues>): UpdateVariantInput {
  const patch: UpdateVariantInput = {}

  if (dirty.title !== undefined && dirty.title.trim() !== '') patch.title = dirty.title.trim()
  if (dirty.priceAmount !== undefined && dirty.priceAmount !== null) {
    patch.priceAmount = dirty.priceAmount
  }
  if (dirty.compareAtAmount !== undefined) patch.compareAtAmount = dirty.compareAtAmount
  if (dirty.sku !== undefined) patch.sku = dirty.sku.trim() || null
  if (dirty.barcode !== undefined) patch.barcode = dirty.barcode.trim() || null
  if (dirty.weightGrams !== undefined) {
    const grams = Number(dirty.weightGrams)
    if (Number.isFinite(grams) && grams >= 0) patch.weightGrams = Math.round(grams)
  }
  if (dirty.requiresShipping !== undefined) patch.requiresShipping = dirty.requiresShipping
  if (dirty.isActive !== undefined) patch.isActive = dirty.isActive
  if (dirty.mediaId !== undefined) patch.mediaId = dirty.mediaId || null

  return patch
}

/** What a variant is called when it has options, and when it does not. */
export function variantLabel(variant: ProductVariant): string {
  return variant.options.length > 0
    ? variant.options.map((option) => option.value).join(' / ')
    : variant.title
}
