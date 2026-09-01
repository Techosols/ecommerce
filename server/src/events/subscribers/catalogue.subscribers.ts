/**
 * Reactions to catalogue events (§12.3).
 *
 * One job, done properly: keeping the per-process caches honest.
 *
 * The API and the worker are separate processes, and there may be several API
 * instances. Each holds its own `TtlCache` of resolved products, so the process
 * that *made* a change invalidates its own copy synchronously, and every other
 * process learns through the event. Without this, a price edit on instance A is
 * invisible on instance B for up to the TTL — a stale price on a product page,
 * which is the one kind of staleness a shop cannot afford.
 *
 * Idempotent by construction: dropping a cache entry twice is dropping it once.
 */
import { createLogger } from '../../infrastructure/logging/logger.js'
import { categoriesService, invalidateProduct } from '../../features/catalogue/index.js'
import { on } from './index.js'

const log = createLogger('events.catalogue')

export function registerCatalogueSubscribers(): void {
  const dropProduct = async (event: { payload: { productId: string } }): Promise<void> => {
    invalidateProduct(event.payload.productId)
    log.debug({ productId: event.payload.productId }, 'product cache invalidated by event')
  }

  on('product.updated', [dropProduct])
  on('product.status_changed', [dropProduct])
  on('product.archived', [dropProduct])
  on('product.published', [dropProduct])
  on('product.unpublished', [dropProduct])
  on('variant.created', [dropProduct])
  on('variant.updated', [dropProduct])
  on('variant.archived', [dropProduct])

  // The category tree is embedded in storefront navigation, so a new node has
  // to appear everywhere rather than in whichever process handled the write.
  on('category.created', [
    async () => {
      categoriesService.clearCache()
    },
  ])
}
