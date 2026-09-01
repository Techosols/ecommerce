import type { OffsetQuery } from '@/types/api'

/**
 * Inventory shapes, mirrored from `server/src/features/inventory/inventory.mapper.ts`.
 *
 * Three distinctions run through every screen built on these:
 *
 *   • **On hand, reserved, available.** `available` is `onHand - reserved` and
 *     is the only one that answers "can I sell this". A screen that shows one
 *     number shows the wrong one.
 *   • **Untracked is not zero.** `trackInventory: false` means the item is
 *     unconditionally sellable — made to order — and its quantity is not a
 *     smaller number, it is a question that does not apply.
 *   • **Nothing sets a quantity.** Stock moves by adjustment, stocktake or
 *     transfer, each of which writes a movement saying why. The ledger is the
 *     evidence and the level is the running total.
 */

export interface StockLevel {
  locationId: string
  locationCode: string
  locationName: string
  onHand: number
  reserved: number
  available: number
  updatedAt: string
}

export interface InventoryTotals {
  onHand: number
  reserved: number
  available: number
}

/** A row in the stock list. Carries the identity of what it counts. */
export interface InventoryItemSummary {
  id: string
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string
  sku: string | null
  trackInventory: boolean
  lowStockThreshold: number | null
  effectiveLowStockThreshold: number
  totals: InventoryTotals
  /** Decided by the server, so no two screens can disagree about the line. */
  isLow: boolean
}

export interface InventoryItemDetail {
  id: string
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string
  sku: string | null
  trackInventory: boolean
  lowStockThreshold: number | null
  effectiveLowStockThreshold: number
  totals: InventoryTotals
  isLow: boolean
  levels: StockLevel[]
}

export type MovementReason =
  | 'receive'
  | 'manual_adjustment'
  | 'stocktake'
  | 'damage'
  | 'waste'
  | 'return'
  | 'correction'
  | 'transfer_in'
  | 'transfer_out'
  | 'reservation'
  | 'reservation_release'
  | 'reservation_commit'
  | 'reservation_expired'

/** The reasons an operator may cite. The rest are written by the system. */
export const OPERATOR_REASONS = [
  'receive',
  'manual_adjustment',
  'stocktake',
  'damage',
  'waste',
  'return',
  'correction',
] as const

export type OperatorReason = (typeof OPERATOR_REASONS)[number]

/**
 * One entry in the ledger.
 *
 * `delta` has two halves because a reservation moves `reserved` without moving
 * `onHand`: stock that is still on the shelf and no longer sellable. Showing
 * only one of them makes a reservation look like nothing happened.
 */
export interface StockMovement {
  id: string
  inventoryItemId: string
  locationId: string
  delta: { onHand: number; reserved: number }
  resulting: { onHand: number; reserved: number }
  reason: MovementReason
  reference: { type: string | null; id: string | null }
  actorUserId: string | null
  note: string | null
  createdAt: string
}

export interface Reservation {
  id: string
  inventoryItemId: string
  locationId: string
  quantity: number
  status: 'active' | 'released' | 'committed' | 'expired'
  owner: { type: 'cart' | 'order' | 'manual'; id: string }
  /** Present when the owner is an order, so the row names something openable. */
  orderNumber: string | null
  expiresAt: string
  resolvedAt: string | null
  createdAt: string
}

export interface Location {
  id: string
  code: string
  name: string
  address: Record<string, unknown> | null
  isActive: boolean
  isDefault: boolean
  position: number
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface InventoryListParams extends OffsetQuery {
  q?: string
  low?: 'true'
  tracked?: 'true' | 'false'
  locationId?: string
}

export interface MovementListParams extends OffsetQuery {
  locationId?: string
  reason?: MovementReason
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Every stock write names its target as a variant *or* an inventory item, never
 * both — the server refuses anything else.
 */
export interface AdjustmentInput {
  inventoryItemId: string
  locationId?: string
  delta: number
  reason: OperatorReason
  note?: string | null
}

export interface StocktakeInput {
  inventoryItemId: string
  locationId?: string
  countedOnHand: number
  note?: string | null
}

export interface TransferInput {
  inventoryItemId: string
  fromLocationId: string
  toLocationId: string
  quantity: number
  note?: string | null
}

export interface CreateLocationInput {
  code: string
  name: string
  position?: number
  isDefault?: boolean
}

export interface UpdateLocationInput {
  code?: string
  name?: string
  isActive?: boolean
  isDefault?: boolean
  position?: number
}
