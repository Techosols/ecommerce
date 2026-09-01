/**
 * The event registry (§12.2).
 *
 * Every domain event has a name and a Zod payload schema. `publish()` accepts
 * only registered names with matching payloads, so an unregistered event or a
 * mistyped field is a compile-time error rather than a runtime surprise.
 *
 * Features add their events here as they are built.
 *
 * **No payload may carry a secret.** `domain_events` is a durable, queryable
 * log, so a raw reset or verification token written here would be a standing
 * credential leak. Credential events carry the token *id* instead, and the
 * email that carries the real token is enqueued directly (see
 * `auth.service.ts`).
 */
import { z } from 'zod'

export const EVENT_SCHEMAS = {
  /** A job exhausted its retries and landed in a dead-letter queue (§8.3). */
  'job.dead_lettered': z.object({
    queue: z.string(),
    jobId: z.string(),
    attempts: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),

  // ── Identity ──────────────────────────────────────────────────────────────
  'user.created': z.object({
    userId: z.uuid(),
    email: z.email(),
    roles: z.array(z.string()),
  }),
  'user.status_changed': z.object({
    userId: z.uuid(),
    from: z.string(),
    to: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'user.roles_changed': z.object({
    userId: z.uuid(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    actorId: z.uuid().nullable(),
  }),

  // ── Customer lifecycle ────────────────────────────────────────────────────
  'customer.registered': z.object({
    userId: z.uuid(),
    email: z.email(),
  }),
  'customer.email_verified': z.object({
    userId: z.uuid(),
    email: z.string(),
  }),

  // ── Authentication ────────────────────────────────────────────────────────
  'auth.login_succeeded': z.object({
    userId: z.uuid(),
    sessionId: z.uuid(),
    ip: z.string().nullable(),
  }),
  'auth.logged_out': z.object({
    userId: z.uuid(),
    sessionId: z.uuid().nullable(),
    scope: z.enum(['session', 'all']),
    sessionsRevoked: z.number().int().nonnegative().optional(),
  }),
  'auth.password_changed': z.object({
    userId: z.uuid(),
    method: z.enum(['change', 'reset']),
  }),
  /** Carries the token id, never the token (see the note above). */
  'auth.password_reset_requested': z.object({
    userId: z.uuid(),
    tokenId: z.uuid(),
    ip: z.string().nullable(),
  }),
  'auth.account_locked': z.object({
    userId: z.uuid(),
    email: z.email(),
    failures: z.number().int().positive(),
  }),

  // ── Store configuration ───────────────────────────────────────────────────
  'settings.updated': z.object({
    changed: z.array(z.string()),
    actorId: z.uuid().nullable(),
  }),

  // ── Media ─────────────────────────────────────────────────────────────────
  /** Bytes arrived and passed inspection; the worker has the asset. */
  'media.uploaded': z.object({
    mediaAssetId: z.uuid(),
    mimeType: z.string(),
    byteSize: z.number().int().nonnegative(),
  }),
  'media.ready': z.object({
    mediaAssetId: z.uuid(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  'media.failed': z.object({
    mediaAssetId: z.uuid(),
    reason: z.string(),
  }),
  'media.deleted': z.object({
    mediaAssetId: z.uuid(),
    storageKey: z.string(),
  }),

  // ── Staff ─────────────────────────────────────────────────────────────────
  /** Carries the token id, never the token (see the note above). */
  'staff.invited': z.object({
    userId: z.uuid(),
    email: z.email(),
    roles: z.array(z.string()),
    tokenId: z.uuid(),
    invitedBy: z.uuid(),
  }),
  'staff.invitation_accepted': z.object({
    userId: z.uuid(),
    email: z.email(),
  }),

  // ── Catalogue ─────────────────────────────────────────────────────────────
  'product.created': z.object({
    productId: z.uuid(),
    handle: z.string(),
    title: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'product.updated': z.object({
    productId: z.uuid(),
    changed: z.array(z.string()),
    actorId: z.uuid().nullable(),
  }),
  /** Editorial lifecycle moved. Not the same as published/unpublished. */
  'product.status_changed': z.object({
    productId: z.uuid(),
    from: z.string(),
    to: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'product.archived': z.object({
    productId: z.uuid(),
    from: z.string(),
    to: z.string(),
    actorId: z.uuid().nullable(),
  }),
  /** Visibility changed on one channel. Carries the channel, not a boolean. */
  'product.published': z.object({
    productId: z.uuid(),
    channelKey: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'product.unpublished': z.object({
    productId: z.uuid(),
    channelKey: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'variant.created': z.object({
    productId: z.uuid(),
    variantId: z.uuid(),
    actorId: z.uuid().nullable(),
  }),
  'variant.updated': z.object({
    productId: z.uuid(),
    variantId: z.uuid(),
    changed: z.array(z.string()),
    actorId: z.uuid().nullable(),
  }),
  'variant.archived': z.object({
    productId: z.uuid(),
    variantId: z.uuid(),
    actorId: z.uuid().nullable(),
  }),
  'category.created': z.object({
    categoryId: z.uuid(),
    handle: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'collection.created': z.object({
    collectionId: z.uuid(),
    handle: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'collection.products_changed': z.object({
    collectionId: z.uuid(),
    productCount: z.number().int().nonnegative(),
    actorId: z.uuid().nullable(),
  }),

  // ── Inventory ─────────────────────────────────────────────────────────────
  'inventory.item_created': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
  }),
  'inventory.adjusted': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    delta: z.number().int(),
    reason: z.string(),
    available: z.number().int(),
    actorId: z.uuid().nullable(),
  }),
  'inventory.tracking_changed': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    trackInventory: z.boolean(),
    actorId: z.uuid().nullable(),
  }),
  'inventory.transferred': z.object({
    transferId: z.uuid(),
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity: z.number().int().positive(),
    actorId: z.uuid().nullable(),
  }),
  'inventory.reserved': z.object({
    reservationId: z.uuid(),
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    quantity: z.number().int().positive(),
    ownerType: z.string(),
    ownerId: z.uuid(),
  }),
  'inventory.released': z.object({
    reservationId: z.uuid(),
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    quantity: z.number().int().positive(),
    ownerType: z.string(),
    ownerId: z.uuid(),
  }),
  'inventory.committed': z.object({
    reservationId: z.uuid(),
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    quantity: z.number().int().positive(),
    ownerType: z.string(),
    ownerId: z.uuid(),
  }),
  'inventory.reservation_expired': z.object({
    reservationId: z.uuid(),
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    quantity: z.number().int().positive(),
    ownerType: z.string(),
    ownerId: z.uuid(),
  }),
  /**
   * Emitted on the *crossing*, never while stock merely sits below the line.
   * The naive version produces thousands of identical events and trains
   * everyone to ignore them.
   */
  'inventory.low_stock': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    available: z.number().int(),
    threshold: z.number().int(),
  }),
  'inventory.out_of_stock': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
  }),
  'inventory.back_in_stock': z.object({
    inventoryItemId: z.uuid(),
    variantId: z.uuid(),
    locationId: z.uuid(),
    available: z.number().int(),
  }),
  'inventory.location_created': z.object({
    locationId: z.uuid(),
    code: z.string(),
    actorId: z.uuid().nullable(),
  }),

  // ── Customers ─────────────────────────────────────────────────────────────
  'customer.status_changed': z.object({
    userId: z.uuid(),
    from: z.string(),
    to: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'customer.marketing_consent_changed': z.object({
    userId: z.uuid(),
    acceptsMarketing: z.boolean(),
  }),
  'customer.address_added': z.object({ userId: z.uuid(), addressId: z.uuid() }),

  // ── Cart ──────────────────────────────────────────────────────────────────
  'cart.created': z.object({ cartId: z.uuid(), customerId: z.uuid().nullable() }),
  'cart.item_added': z.object({
    cartId: z.uuid(),
    variantId: z.uuid(),
    quantity: z.number().int().positive(),
  }),
  'cart.item_removed': z.object({ cartId: z.uuid(), variantId: z.uuid() }),
  'cart.converted': z.object({ cartId: z.uuid(), orderId: z.uuid() }),
  'cart.abandoned': z.object({ cartId: z.uuid(), customerId: z.uuid().nullable() }),

  // ── Orders ────────────────────────────────────────────────────────────────
  'order.placed': z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    customerId: z.uuid().nullable(),
    email: z.email(),
    totalCents: z.number().int().nonnegative(),
    currency: z.string(),
    itemCount: z.number().int().positive(),
  }),
  'order.status_changed': z.object({
    orderId: z.uuid(),
    field: z.string(),
    from: z.string(),
    to: z.string(),
    actorId: z.uuid().nullable(),
  }),
  'order.confirmed': z.object({ orderId: z.uuid(), orderNumber: z.string(), email: z.email() }),
  'order.cancelled': z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
    reason: z.string().nullable(),
    restocked: z.boolean(),
  }),
  'order.completed': z.object({ orderId: z.uuid(), orderNumber: z.string() }),

  // ── Payments ──────────────────────────────────────────────────────────────
  'payment.created': z.object({
    paymentId: z.uuid(),
    orderId: z.uuid(),
    amountCents: z.number().int().positive(),
    method: z.string(),
  }),
  'payment.succeeded': z.object({
    paymentId: z.uuid(),
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
    amountCents: z.number().int().positive(),
  }),
  'payment.failed': z.object({
    paymentId: z.uuid(),
    orderId: z.uuid(),
    reason: z.string().nullable(),
  }),
  'payment.refunded': z.object({
    refundId: z.uuid(),
    paymentId: z.uuid(),
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
    amountCents: z.number().int().positive(),
    restock: z.boolean(),
  }),

  // ── Shipping ──────────────────────────────────────────────────────────────
  'shipment.created': z.object({
    shipmentId: z.uuid(),
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
    itemCount: z.number().int().positive(),
  }),
  'shipment.shipped': z.object({
    shipmentId: z.uuid(),
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    trackingUrl: z.string().nullable(),
  }),
  'shipment.delivered': z.object({
    shipmentId: z.uuid(),
    orderId: z.uuid(),
    orderNumber: z.string(),
    email: z.email(),
  }),

  // ── Discounts ─────────────────────────────────────────────────────────────
  'discount.created': z.object({ discountId: z.uuid(), code: z.string(), actorId: z.uuid().nullable() }),
  'discount.redeemed': z.object({
    discountId: z.uuid(),
    code: z.string(),
    orderId: z.uuid(),
    customerId: z.uuid().nullable(),
    amountCents: z.number().int().nonnegative(),
  }),

  // ── Notifications ─────────────────────────────────────────────────────────
  'notification.created': z.object({
    notificationId: z.uuid(),
    userId: z.uuid(),
    type: z.string(),
    audience: z.string(),
  }),

  // ── Security ──────────────────────────────────────────────────────────────
  /** A refresh token was presented after it had already been rotated (§6.3). */
  'auth.token_reuse_detected': z.object({
    userId: z.uuid(),
    familyId: z.uuid(),
    sessionsRevoked: z.number().int().nonnegative(),
    ip: z.string().nullable(),
  }),
} as const satisfies Record<string, z.ZodType>

export type EventName = keyof typeof EVENT_SCHEMAS
export type EventPayload<E extends EventName> = z.infer<(typeof EVENT_SCHEMAS)[E]>

/**
 * The aggregate an event belongs to. Used for the
 * `(aggregate_type, aggregate_id)` index that answers "what happened to X".
 */
export const EVENT_AGGREGATES: Record<EventName, string> = {
  'job.dead_lettered': 'job',
  'user.created': 'user',
  'user.status_changed': 'user',
  'user.roles_changed': 'user',
  'customer.registered': 'user',
  'customer.email_verified': 'user',
  'auth.login_succeeded': 'user',
  'auth.logged_out': 'user',
  'auth.password_changed': 'user',
  'auth.password_reset_requested': 'user',
  'auth.account_locked': 'user',
  'auth.token_reuse_detected': 'user',
  'settings.updated': 'store_settings',
  'media.uploaded': 'media_asset',
  'media.ready': 'media_asset',
  'media.failed': 'media_asset',
  'media.deleted': 'media_asset',
  'product.created': 'product',
  'product.updated': 'product',
  'product.status_changed': 'product',
  'product.archived': 'product',
  'product.published': 'product',
  'product.unpublished': 'product',
  'variant.created': 'product',
  'variant.updated': 'product',
  'variant.archived': 'product',
  'category.created': 'category',
  'collection.created': 'collection',
  'collection.products_changed': 'collection',
  'inventory.item_created': 'inventory_item',
  'inventory.adjusted': 'inventory_item',
  'inventory.tracking_changed': 'inventory_item',
  'inventory.transferred': 'inventory_item',
  'inventory.reserved': 'inventory_item',
  'inventory.released': 'inventory_item',
  'inventory.committed': 'inventory_item',
  'inventory.reservation_expired': 'inventory_item',
  'inventory.low_stock': 'inventory_item',
  'inventory.out_of_stock': 'inventory_item',
  'inventory.back_in_stock': 'inventory_item',
  'inventory.location_created': 'inventory_location',
  'customer.status_changed': 'user',
  'customer.marketing_consent_changed': 'user',
  'customer.address_added': 'user',
  'cart.created': 'cart',
  'cart.item_added': 'cart',
  'cart.item_removed': 'cart',
  'cart.converted': 'cart',
  'cart.abandoned': 'cart',
  'order.placed': 'order',
  'order.status_changed': 'order',
  'order.confirmed': 'order',
  'order.cancelled': 'order',
  'order.completed': 'order',
  'payment.created': 'order',
  'payment.succeeded': 'order',
  'payment.failed': 'order',
  'payment.refunded': 'order',
  'shipment.created': 'order',
  'shipment.shipped': 'order',
  'shipment.delivered': 'order',
  'discount.created': 'discount',
  'discount.redeemed': 'discount',
  'notification.created': 'notification',
  'staff.invited': 'user',
  'staff.invitation_accepted': 'user',
}

export function isKnownEvent(name: string): name is EventName {
  return name in EVENT_SCHEMAS
}
