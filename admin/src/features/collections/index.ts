/**
 * Public surface of the collections feature.
 *
 * The pages are what the router mounts; the hooks are what the product screens
 * reach for — a product page showing which collections it is in, and the
 * product list running a bulk change.
 */
export { CollectionDetailPage } from './pages/CollectionDetailPage'
export { CollectionListPage } from './pages/CollectionListPage'

export {
  collectionKeys,
  useBulkProductAction,
  useCollections,
  useProductCollections,
} from './hooks/collections.hooks'

export type {
  BulkAction,
  BulkActionResult,
  Collection,
  CollectionDetail,
  CollectionSummary,
  CollectionType,
  ProductCollection,
} from './types/collections.types'
