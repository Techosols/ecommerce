/**
 * Reactions to inventory events (§12.3).
 *
 * This file is where the catalogue and inventory meet, and it exists precisely
 * so that they do not import each other. Inventory never reads a catalogue
 * table; the catalogue never learns that stock moved. A subscriber knows both,
 * which is what `subscribers/` is for.
 *
 * ── On cache correctness ────────────────────────────────────────────────────
 *
 * The catalogue caches a product's *shape* — its options, variants, media — for
 * sixty seconds. It deliberately does **not** cache availability: the storefront
 * mapper resolves that per request, in one batched query, so "stock is zero but
 * the page says in stock" is impossible by construction rather than by
 * remembering to invalidate.
 *
 * The invalidation below is therefore defence in depth, not the mechanism. It
 * costs one map delete and it means that if anyone ever does cache availability
 * inside the product detail, the path already exists and already works across
 * processes. Cache correctness is worth more than the saved microsecond.
 *
 * Idempotent by construction: dropping a cache entry twice is dropping it once.
 */
import { createLogger } from '../../infrastructure/logging/logger.js'
import {
  REALTIME_EVENTS,
  ROOMS,
  emitToAdminRoom,
} from '../../infrastructure/realtime/index.js'
import { invalidateProduct, productsService } from '../../features/catalogue/index.js'
import { notificationsService } from '../../features/notifications/index.js'
import { on } from './index.js'

const log = createLogger('events.inventory')

/**
 * Inventory events carry a `variantId`, because inventory does not know about
 * products. Resolving it to a product is the catalogue's job, asked politely.
 */
async function dropProductCacheForVariant(variantId: string): Promise<void> {
  const productId = await productsService.productIdForVariant(variantId)
  if (!productId) return
  invalidateProduct(productId)
  log.debug({ variantId, productId }, 'product cache invalidated after a stock change')
}

export function registerInventorySubscribers(): void {
  const dropCache = async (event: { payload: { variantId: string } }): Promise<void> => {
    await dropProductCacheForVariant(event.payload.variantId)
  }

  // Every event that can change what a customer would be told.
  on('inventory.adjusted', [dropCache])
  on('inventory.reserved', [dropCache])
  on('inventory.released', [dropCache])
  on('inventory.committed', [dropCache])
  on('inventory.reservation_expired', [dropCache])
  on('inventory.transferred', [dropCache])
  // Switching tracking off makes an item unconditionally purchasable, which is
  // as much a change to the storefront as running out would be.
  on('inventory.tracking_changed', [dropCache])

  // ── Operator-facing signals ───────────────────────────────────────────────
  //
  // These fire on the *crossing* only, never while stock merely sits below the
  // line, which is what makes them worth notifying on at all: the naive version
  // produces thousands of identical alerts and trains everyone to ignore them.
  //
  // Staff-only, on every channel: a badge that survives a refresh, plus a socket
  // nudge for whoever has the console open. `dedupeKey` is the event id, so a
  // redelivered event does not produce a second badge.

  on('inventory.low_stock', [
    async (event) => {
      const title = await variantLabel(event.payload.variantId)
      await notificationsService.notifyStaff({
        type: 'inventory.low_stock',
        title: `Low stock: ${title}`,
        body: `${event.payload.available} left, at or below the threshold of ${event.payload.threshold}.`,
        data: { variantId: event.payload.variantId, available: event.payload.available },
        dedupeKey: `low-stock:${event.eventId}`,
      })
      emitToAdminRoom(ROOMS.adminInventory(), REALTIME_EVENTS.ADMIN_LOW_STOCK, {
        variantId: event.payload.variantId,
        available: event.payload.available,
        threshold: event.payload.threshold,
      })
      log.warn(
        {
          inventoryItemId: event.payload.inventoryItemId,
          variantId: event.payload.variantId,
          available: event.payload.available,
          threshold: event.payload.threshold,
        },
        'stock has fallen to its low-stock threshold',
      )
    },
  ])

  on('inventory.out_of_stock', [
    async (event) => {
      await dropProductCacheForVariant(event.payload.variantId)
      const title = await variantLabel(event.payload.variantId)
      await notificationsService.notifyStaff({
        type: 'inventory.out_of_stock',
        title: `Out of stock: ${title}`,
        body: 'This variant can no longer be bought.',
        data: { variantId: event.payload.variantId },
        dedupeKey: `out-of-stock:${event.eventId}`,
      })
      emitToAdminRoom(ROOMS.adminInventory(), REALTIME_EVENTS.ADMIN_OUT_OF_STOCK, {
        variantId: event.payload.variantId,
      })
      log.warn(
        { inventoryItemId: event.payload.inventoryItemId, variantId: event.payload.variantId },
        'stock has run out',
      )
    },
  ])

  on('inventory.back_in_stock', [
    async (event) => {
      await dropProductCacheForVariant(event.payload.variantId)
      emitToAdminRoom(ROOMS.adminInventory(), REALTIME_EVENTS.ADMIN_BACK_IN_STOCK, {
        variantId: event.payload.variantId,
        available: event.payload.available,
      })
      log.info(
        { inventoryItemId: event.payload.inventoryItemId, available: event.payload.available },
        'stock is available again',
      )
    },
  ])
}

/**
 * A human-readable label for an alert.
 *
 * "Low stock: 4f2c-…" is a notification nobody acts on. Resolving the variant to
 * a product title is the catalogue's job, asked politely, and a missing product
 * falls back to the id rather than failing the subscriber.
 */
async function variantLabel(variantId: string): Promise<string> {
  const productId = await productsService.productIdForVariant(variantId)
  if (!productId) return variantId
  const product = await productsService.getById(productId)
  return product?.title ?? variantId
}
