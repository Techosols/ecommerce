/**
 * Public surface of the inventory feature.
 *
 * The pages are what the router mounts; the hooks and the labels are what the
 * product screens reach for, since a variant's stock is shown there too.
 */
export { InventoryItemPage } from './pages/InventoryItemPage'
export { InventoryListPage } from './pages/InventoryListPage'
export { LocationsPage } from './pages/LocationsPage'

export {
  inventoryKeys,
  useInventoryItem,
  useInventoryList,
  useLocations,
} from './hooks/inventory.hooks'
export { reasonLabel, reasonTone, signed } from './components/inventoryLabels'

export type {
  InventoryItemDetail,
  InventoryItemSummary,
  Location,
  MovementReason,
  Reservation,
  StockLevel,
  StockMovement,
} from './types/inventory.types'
