import type { RuleField, RuleSet } from '@/components/rules'
import { api } from '@/lib/api/client'
import type {
  BulkActionInput,
  BulkActionResult,
  Collection,
  CollectionDetail,
  CollectionPreview,
  CollectionSummary,
  CreateCollectionInput,
  ProductCollection,
  UpdateCollectionInput,
} from '../types/collections.types'

/**
 * The collection endpoints, exactly as `catalogue.admin.routes.ts` publishes them.
 *
 * Note the two ways membership changes, which are deliberately not the same
 * call. `setProducts` is a PUT because reordering is wholesale — the order is
 * the content, and rebuilding an arrangement from individual moves is how it
 * drifts. `addProducts` exists because "add these four from the product list"
 * should not require fetching and resending everything already in there, which
 * is how two people editing at once undo each other.
 */
export const collectionsApi = {
  list: () => api.get<CollectionSummary[]>('/admin/collections'),

  detail: (id: string) => api.get<CollectionDetail>(`/admin/collections/${id}`),

  create: (body: CreateCollectionInput) => api.post<Collection>('/admin/collections', body),

  update: (id: string, body: UpdateCollectionInput) =>
    api.patch<Collection>(`/admin/collections/${id}`, body),

  archive: (id: string) => api.delete<void>(`/admin/collections/${id}`),

  /** Replaces membership and order in one move. Manual collections only. */
  setProducts: (id: string, productIds: string[]) =>
    api.put<{ productIds: string[] }>(`/admin/collections/${id}/products`, { productIds }),

  addProducts: (id: string, productIds: string[]) =>
    api.post<{ productIds: string[] }>(`/admin/collections/${id}/products`, { productIds }),

  removeProducts: (id: string, productIds: string[]) =>
    api.delete<{ productIds: string[] }>(`/admin/collections/${id}/products`, { productIds }),

  /** The field table the rule builder is generated from. Never written here. */
  ruleFields: () => api.get<RuleField[]>('/admin/collections/rules/fields'),

  preview: (rules: RuleSet) =>
    api.post<CollectionPreview>('/admin/collections/preview', { rules }),

  /** Both kinds, each saying whether a rule put the product there. */
  forProduct: (productId: string) =>
    api.get<ProductCollection[]>(`/admin/products/${productId}/collections`),

  bulk: (body: BulkActionInput) => api.post<BulkActionResult>('/admin/products/bulk', body),
}
