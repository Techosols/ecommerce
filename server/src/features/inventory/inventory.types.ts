/**
 * Inventory domain types (docs/inventory.md).
 *
 * The vocabulary matters, because three things that sound alike are not:
 *
 *   **Variant** — what a customer buys. Owned by the catalogue.
 *   **Inventory item** — what a stockroom tracks. One per variant today.
 *   **Inventory level** — how much of an item is at one location.
 *
 * Quantity appears on exactly one of them.
 */

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

export type MovementReferenceType =
  | 'manual'
  | 'reservation'
  | 'transfer'
  | 'order'
  | 'return'
  | 'stocktake'

export type ReservationStatus = 'active' | 'released' | 'committed' | 'expired'
export type ReservationOwnerType = 'cart' | 'order' | 'manual'

/**
 * What the storefront is told. Deliberately not a number: see docs/inventory.md
 * §12 — exposing exact stock is a product decision, and the default is no.
 */
export type AvailabilityState = 'in_stock' | 'out_of_stock' | 'made_to_order'

export interface InventoryLocation {
  id: string
  code: string
  name: string
  address: Record<string, unknown>
  isActive: boolean
  isDefault: boolean
  position: number
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export interface InventoryItem {
  id: string
  variantId: string
  trackInventory: boolean
  /** NULL means "use the store default", which is not the same as 0. */
  lowStockThreshold: number | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export interface InventoryLevel {
  id: string
  inventoryItemId: string
  locationId: string
  onHand: number
  reserved: number
  /** Derived by the database. Never written, never able to drift. */
  available: number
  createdAt: Date
  updatedAt: Date
}

export interface InventoryMovement {
  id: string
  inventoryItemId: string
  locationId: string
  deltaOnHand: number
  deltaReserved: number
  reason: MovementReason
  referenceType: MovementReferenceType | null
  referenceId: string | null
  resultingOnHand: number
  resultingReserved: number
  actorUserId: string | null
  note: string | null
  createdAt: Date
}

export interface Reservation {
  id: string
  inventoryItemId: string
  locationId: string
  quantity: number
  status: ReservationStatus
  ownerType: ReservationOwnerType
  ownerId: string
  expiresAt: Date
  resolvedAt: Date | null
  resolvedBy: string | null
  createdAt: Date
  updatedAt: Date
}

/** An item with its levels — the shape the admin inventory screen renders. */
export interface InventoryItemDetail extends InventoryItem {
  levels: (InventoryLevel & { locationCode: string; locationName: string })[]
  totalOnHand: number
  totalReserved: number
  totalAvailable: number
  effectiveLowStockThreshold: number
  /**
   * What is being counted. An item id names a row; nobody stocktakes a row.
   * Carried here for the same reason the list summary carries it: a stock
   * figure with no identity is a number an operator cannot act on, and the
   * screen would otherwise have to guess a product from a variant id.
   */
  identity: {
    productId: string
    productTitle: string
    variantTitle: string
    sku: string | null
  }
}

/**
 * What the catalogue needs to answer "can this be bought?", per variant.
 *
 * `quantity` is present for the admin surface and deliberately dropped by the
 * storefront mapper — one type, two audiences, and the DTO decides.
 */
export interface VariantAvailability {
  variantId: string
  inventoryItemId: string | null
  trackInventory: boolean
  available: number
  state: AvailabilityState
  inStock: boolean
}

export interface AdjustmentInput {
  variantId?: string
  inventoryItemId?: string
  locationId?: string
  /** Signed. `+10` receives, `-2` writes off. */
  delta: number
  reason: MovementReason
  note?: string | null
  referenceType?: MovementReferenceType
  referenceId?: string | null
}

export interface StocktakeInput {
  variantId?: string
  inventoryItemId?: string
  locationId?: string
  /** The counted figure. The delta is computed from what we thought we had. */
  countedOnHand: number
  note?: string | null
}

export interface ReserveInput {
  variantId?: string
  inventoryItemId?: string
  locationId?: string
  quantity: number
  ownerType: ReservationOwnerType
  ownerId: string
  /** Defaults to the store's reservation TTL setting. */
  expiresInMinutes?: number
}

export interface MovementFilter {
  inventoryItemId?: string
  locationId?: string
  reason?: MovementReason
  limit: number
  offset: number
}
