import { api } from '@/lib/api/client'
import type {
  AddOptionInput,
  CreateProductInput,
  OptionInput,
  ProductDetail,
  ProductListParams,
  ProductSummary,
  ProductVariant,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
  VariantInventory,
} from '../types/products.types'
import type { AdjustmentReason } from '../types/products.types'

/**
 * The catalogue endpoints for products, exactly as
 * `catalogue.admin.routes.ts` publishes them.
 *
 * Note what is *not* here, because the server does not offer it and inventing
 * it would be inventing an endpoint:
 *
 *   • no `DELETE /products/:id` — archiving is the only retirement
 *   • no status field on `update` — activate / archive / restore are their own
 *     routes, each an explicit decision with its own audit entry
 *   • no price on the product — price belongs to a variant
 *
 * Permissions, enforced by the server on every call: `catalog:read` for the
 * two reads, `catalog:write` for everything else, and `catalog:publish` for
 * publish and unpublish.
 */
export const productsApi = {
  list: (params: ProductListParams) =>
    api.list<ProductSummary>('/admin/products', {
      query: {
        page: params.page,
        limit: params.limit,
        status: params.status,
        categoryId: params.categoryId,
        collectionId: params.collectionId,
        q: params.q,
        sort: params.sort,
        direction: params.direction,
      },
    }),

  detail: (id: string) => api.get<ProductDetail>(`/admin/products/${id}`),

  create: (input: CreateProductInput) => api.post<ProductDetail>('/admin/products', input),

  update: (id: string, patch: UpdateProductInput) =>
    api.patch<ProductDetail>(`/admin/products/${id}`, patch),

  /** Refused while live variants exist — they select values that would vanish. */
  replaceOptions: (id: string, options: OptionInput[]) =>
    api.put<ProductDetail>(`/admin/products/${id}/options`, { options }),

  /**
   * Adds a whole new axis — "Colour" onto a product that only had "Size".
   *
   * `appliesToExisting` is the value every variant already on the product takes
   * on the new option; without it they would have nothing to select, which is
   * the one state the model forbids. Creates no new variants.
   */
  addOption: (id: string, input: AddOptionInput) =>
    api.post<ProductDetail>(`/admin/products/${id}/options`, input),

  /**
   * Appends a value to an existing option — "XL" onto Size.
   *
   * Safe on a live product in a way `replaceOptions` is not: nothing selects the
   * new value yet, so every variant still chooses one value per option. It
   * creates no variants; that is a separate merchandising decision.
   */
  addOptionValue: (id: string, optionId: string, value: string) =>
    api.post<ProductDetail>(`/admin/products/${id}/options/${optionId}/values`, { value }),

  /**
   * Sets or clears what one value looks like. Safe on a live product: it
   * changes how a value is drawn, never which variants exist or what they
   * select. `null` clears it and the storefront shows the name again.
   */
  setOptionValueSwatch: (id: string, optionId: string, valueId: string, swatchHex: string | null) =>
    api.patch<ProductDetail>(`/admin/products/${id}/options/${optionId}/values/${valueId}`, {
      swatchHex,
    }),

  /** Refused with `OPTION_VALUE_IN_USE` while any variant still records it. */
  removeOptionValue: (id: string, optionId: string, valueId: string) =>
    api.delete<ProductDetail>(`/admin/products/${id}/options/${optionId}/values/${valueId}`),

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  activate: (id: string) => api.post<ProductDetail>(`/admin/products/${id}/activate`),
  archive: (id: string) => api.post<ProductDetail>(`/admin/products/${id}/archive`),
  /** Restores to `draft`, never straight back onto the storefront. */
  restore: (id: string) => api.post<ProductDetail>(`/admin/products/${id}/restore`),

  publish: (id: string, channel?: string) =>
    api.post<ProductDetail>(`/admin/products/${id}/publish`, channel ? { channel } : {}),
  unpublish: (id: string, channel?: string) =>
    api.post<ProductDetail>(`/admin/products/${id}/unpublish`, channel ? { channel } : {}),

  // ── Variants ──────────────────────────────────────────────────────────────

  addVariant: (productId: string, input: VariantInput) =>
    api.post<ProductVariant>(`/admin/products/${productId}/variants`, input),

  updateVariant: (variantId: string, patch: UpdateVariantInput) =>
    api.patch<ProductVariant>(`/admin/variants/${variantId}`, patch),

  /** DELETE is the verb; the effect is an archive, and the 204 destroys nothing. */
  archiveVariant: (variantId: string) => api.delete<void>(`/admin/variants/${variantId}`),

  // ── Media ─────────────────────────────────────────────────────────────────

  attachMedia: (
    productId: string,
    input: { mediaId: string; alt?: string | null; isPrimary?: boolean },
  ) => api.post<ProductDetail>(`/admin/products/${productId}/media`, input),

  /** The whole arrangement in one call: order *is* the content. */
  reorderMedia: (productId: string, order: string[], primaryId?: string) =>
    api.put<ProductDetail>(`/admin/products/${productId}/media/order`, {
      order,
      ...(primaryId ? { primaryId } : {}),
    }),

  detachMedia: (productId: string, productMediaId: string) =>
    api.delete<void>(`/admin/products/${productId}/media/${productMediaId}`),

  // ── Inventory, from the inventory feature's own route ──────────────────────

  /** Behind `inventory:read`; the product page degrades when it is absent. */
  variantInventory: (variantId: string) =>
    api.get<VariantInventory>(`/admin/inventory/variants/${variantId}`),

  /**
   * Moves stock by a delta, with a reason — the ledger's own vocabulary.
   *
   * Deliberately not "set the quantity to N": the server records movements, and
   * a delta with a reason is what an audit can later explain. `inventory:adjust`.
   */
  adjustStock: (input: {
    variantId: string
    delta: number
    reason: AdjustmentReason
    note?: string | null
    locationId?: string
  }) =>
    api.post<{ inventoryItemId: string; onHand: number; reserved: number; available: number }>(
      '/admin/inventory/adjustments',
      {
        variantId: input.variantId,
        delta: input.delta,
        reason: input.reason,
        ...(input.note ? { note: input.note } : {}),
        ...(input.locationId ? { locationId: input.locationId } : {}),
      },
    ),

  /** Whether stock is tracked at all, and where "low" sits. `inventory:manage`. */
  updateInventoryItem: (
    inventoryItemId: string,
    patch: { trackInventory?: boolean; lowStockThreshold?: number | null },
  ) => api.patch<VariantInventory>(`/admin/inventory/items/${inventoryItemId}`, patch),
}
