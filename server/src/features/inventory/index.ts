/**
 * Public surface of the `inventory` feature (§2.2).
 *
 * The dependency direction is deliberate and one-way: **catalogue → inventory**.
 * The catalogue asks whether a variant can be sold; inventory never reads a
 * catalogue table and never imports the catalogue. The one place both are
 * needed — invalidating the product cache when stock moves — is a subscriber in
 * `events/subscribers/`, which is exactly what that file is for.
 *
 * Routes are mounted by `router.ts` directly, not re-exported here.
 */
export { inventoryService } from './inventory.service.js'
export { reservationsService } from './reservations.service.js'
export { locationsService } from './locations.service.js'
export { availabilityService, inStockJoin, IN_STOCK_PREDICATE } from './availability.js'
export type {
  AvailabilityState,
  AdjustmentInput,
  InventoryItem,
  InventoryItemDetail,
  InventoryLevel,
  InventoryLocation,
  InventoryMovement,
  MovementReason,
  MovementReferenceType,
  Reservation,
  ReservationOwnerType,
  ReservationStatus,
  ReserveInput,
  StocktakeInput,
  VariantAvailability,
} from './inventory.types.js'
export { publicAvailabilityDto } from './inventory.mapper.js'
