import { api } from '@/lib/api/client'
import type {
  AdjustmentInput,
  CreateLocationInput,
  InventoryItemDetail,
  InventoryItemSummary,
  InventoryListParams,
  Location,
  MovementListParams,
  Reservation,
  StockMovement,
  StocktakeInput,
  TransferInput,
  UpdateLocationInput,
} from '../types/inventory.types'

/**
 * The inventory endpoints, exactly as `inventory.admin.routes.ts` publishes them.
 *
 * Note what is absent: there is no way to *set* a quantity. Stock moves by an
 * adjustment (a delta and a reason), a stocktake (a counted figure the server
 * turns into a delta) or a transfer, and each writes a movement recording why.
 * A `PUT /levels/:id { onHand: 40 }` would be a stock figure with no
 * explanation, which is the one thing an inventory system must never hold.
 *
 * Three permissions divide these: `inventory:read` to look, `inventory:adjust`
 * to move stock, `inventory:manage` for policy and locations.
 */
export const inventoryApi = {
  list: (params: InventoryListParams) =>
    api.list<InventoryItemSummary>('/admin/inventory', {
      query: {
        page: params.page,
        limit: params.limit,
        q: params.q,
        low: params.low,
        tracked: params.tracked,
        locationId: params.locationId,
      },
    }),

  item: (id: string) => api.get<InventoryItemDetail>(`/admin/inventory/items/${id}`),

  /** The catalogue screens hold a variant id, not an item id. */
  forVariant: (variantId: string) =>
    api.get<InventoryItemDetail>(`/admin/inventory/variants/${variantId}`),

  history: (id: string, params: MovementListParams) =>
    api.list<StockMovement>(`/admin/inventory/items/${id}/history`, {
      query: {
        page: params.page,
        limit: params.limit,
        locationId: params.locationId,
        reason: params.reason,
      },
    }),

  /** What is holding this item's stock right now. Active reservations only. */
  reservations: (id: string) =>
    api.get<Reservation[]>(`/admin/inventory/items/${id}/reservations`),

  /** Tracking policy and the low-stock line. `inventory:manage`. */
  updateItem: (
    id: string,
    patch: { trackInventory?: boolean; lowStockThreshold?: number | null },
  ) => api.patch<InventoryItemDetail>(`/admin/inventory/items/${id}`, patch),

  // ── Movements ─────────────────────────────────────────────────────────────

  adjust: (body: AdjustmentInput) =>
    api.post<{ inventoryItemId: string; onHand: number; reserved: number; available: number }>(
      '/admin/inventory/adjustments',
      body,
    ),

  /**
   * A counted figure, not a delta.
   *
   * The difference matters: the server works out the correction from what it
   * currently holds, so a count taken from a shelf cannot be turned into the
   * wrong movement by a browser doing the subtraction against a number that
   * was already stale when it rendered.
   */
  stocktake: (body: StocktakeInput) =>
    api.post<{ inventoryItemId: string; onHand: number; reserved: number; available: number }>(
      '/admin/inventory/stocktake',
      body,
    ),

  transfer: (body: TransferInput) =>
    api.post<{ from: unknown; to: unknown }>('/admin/inventory/transfers', body),

  // ── Locations ─────────────────────────────────────────────────────────────

  locations: () => api.get<Location[]>('/admin/locations'),

  createLocation: (body: CreateLocationInput) => api.post<Location>('/admin/locations', body),

  updateLocation: (id: string, body: UpdateLocationInput) =>
    api.patch<Location>(`/admin/locations/${id}`, body),

  archiveLocation: (id: string) => api.delete<void>(`/admin/locations/${id}`),
}
