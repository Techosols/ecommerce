/**
 * Cart DTOs (§7.3).
 *
 * The cart is a storefront resource, so there is one serializer. It carries
 * prices — the server's prices — and the reason a line cannot be bought, in
 * words a shopper understands rather than an error code.
 */
import type { ResolvedCart, ResolvedCartLine } from './carts.types.js'

function lineDto(line: ResolvedCartLine) {
  return {
    variantId: line.variantId,
    productId: line.productId,
    handle: line.handle,
    productTitle: line.productTitle,
    variantTitle: line.variantTitle,
    sku: line.sku,
    options: line.options,
    image: line.imageUrl,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    purchasable: line.purchasable,
    availability: line.availability,
    problem: line.problem,
  }
}

export function cartDto(resolved: ResolvedCart) {
  return {
    id: resolved.cart.id,
    status: resolved.cart.status,
    currency: resolved.cart.currency,
    lines: resolved.lines.map(lineDto),
    totals: resolved.totals,
    purchasable: resolved.purchasable,
    updatedAt: resolved.cart.updatedAt.toISOString(),
  }
}
