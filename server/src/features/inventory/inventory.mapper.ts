/**
 * Inventory DTOs (§7.3).
 *
 * The storefront serializer is the important one, and it is written here in
 * full rather than derived from the admin shape by deletion. What a customer
 * may know is a **state**, not a number:
 *
 * ```
 *   { "available": true, "availability": "in_stock" }
 * ```
 *
 * Exposing exact stock is a product decision with real consequences —
 * competitors read it, scarcity messaging becomes a claim you must stand
 * behind, and "3 left" invites a race you then have to lose gracefully. The
 * default here is no, and `publicAvailabilityDto` is the one place that would
 * change if someone decides otherwise (docs/inventory.md §12).
 */
import type {
  InventoryItemDetail,
  InventoryLocation,
  InventoryMovement,
  Reservation,
  VariantAvailability,
} from './inventory.types.js'

// ── Storefront ──────────────────────────────────────────────────────────────

/**
 * Everything a shopfront needs and nothing it does not. No quantities, no
 * locations, no movement history, no staff, no suppliers.
 */
export function publicAvailabilityDto(availability: VariantAvailability) {
  return {
    available: availability.inStock,
    availability: availability.state,
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export function adminLocationDto(location: InventoryLocation) {
  return {
    id: location.id,
    code: location.code,
    name: location.name,
    address: location.address,
    isActive: location.isActive,
    isDefault: location.isDefault,
    position: location.position,
    isArchived: location.archivedAt !== null,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  }
}

export function adminInventoryItemDto(detail: InventoryItemDetail) {
  return {
    id: detail.id,
    variantId: detail.variantId,
    // Flattened rather than nested, so the item page and the list row read the
    // same four field names.
    productId: detail.identity.productId,
    productTitle: detail.identity.productTitle,
    variantTitle: detail.identity.variantTitle,
    sku: detail.identity.sku,
    trackInventory: detail.trackInventory,
    lowStockThreshold: detail.lowStockThreshold,
    effectiveLowStockThreshold: detail.effectiveLowStockThreshold,
    totals: {
      onHand: detail.totalOnHand,
      reserved: detail.totalReserved,
      available: detail.totalAvailable,
    },
    // Whether it is low is computed once here, so four screens cannot disagree
    // about where the line is.
    isLow: detail.trackInventory && detail.totalAvailable <= detail.effectiveLowStockThreshold,
    levels: detail.levels.map((level) => ({
      locationId: level.locationId,
      locationCode: level.locationCode,
      locationName: level.locationName,
      onHand: level.onHand,
      reserved: level.reserved,
      available: level.available,
      updatedAt: level.updatedAt.toISOString(),
    })),
    createdAt: detail.createdAt.toISOString(),
    updatedAt: detail.updatedAt.toISOString(),
  }
}

export function adminItemSummaryDto(
  row: {
    item: { id: string; variantId: string; trackInventory: boolean; lowStockThreshold: number | null }
    productId: string
    productTitle: string
    variantTitle: string
    sku: string | null
    totalOnHand: number
    totalReserved: number
    totalAvailable: number
  },
  defaultThreshold: number,
) {
  const threshold = row.item.lowStockThreshold ?? defaultThreshold
  return {
    id: row.item.id,
    variantId: row.item.variantId,
    // The identity of the thing being counted. A stock figure without it is a
    // number nobody can act on.
    productId: row.productId,
    productTitle: row.productTitle,
    variantTitle: row.variantTitle,
    sku: row.sku,
    trackInventory: row.item.trackInventory,
    lowStockThreshold: row.item.lowStockThreshold,
    effectiveLowStockThreshold: threshold,
    totals: {
      onHand: row.totalOnHand,
      reserved: row.totalReserved,
      available: row.totalAvailable,
    },
    // Decided here rather than in the browser, so the list and the item page
    // cannot disagree about where the line is.
    isLow: row.item.trackInventory && row.totalAvailable <= threshold,
  }
}

/** The stock ledger. What happened, in order, and who did it. */
export function adminMovementDto(movement: InventoryMovement) {
  return {
    id: movement.id,
    inventoryItemId: movement.inventoryItemId,
    locationId: movement.locationId,
    delta: { onHand: movement.deltaOnHand, reserved: movement.deltaReserved },
    resulting: { onHand: movement.resultingOnHand, reserved: movement.resultingReserved },
    reason: movement.reason,
    reference: movement.referenceType
      ? { type: movement.referenceType, id: movement.referenceId }
      : null,
    actorUserId: movement.actorUserId,
    note: movement.note,
    createdAt: movement.createdAt.toISOString(),
  }
}

export function adminReservationDto(reservation: Reservation) {
  return {
    id: reservation.id,
    inventoryItemId: reservation.inventoryItemId,
    locationId: reservation.locationId,
    quantity: reservation.quantity,
    status: reservation.status,
    owner: { type: reservation.ownerType, id: reservation.ownerId },
    expiresAt: reservation.expiresAt.toISOString(),
    resolvedAt: reservation.resolvedAt?.toISOString() ?? null,
    createdAt: reservation.createdAt.toISOString(),
  }
}
