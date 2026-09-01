/**
 * Carts, from the shop's side (§8.4).
 *
 * A cart is the only record of a sale that did not happen, which is why it is
 * worth reading: what people put down, what it was worth, and how often. The
 * sweep in `carts.abandoned_scan` already marks a cart abandoned once nobody
 * has touched it since its expiry and raises `cart.abandoned`; this is the read
 * side of that, plus the one action worth taking — sending the shopper a link
 * back to what they left.
 *
 * `orders:read` rather than a permission of its own: a cart is a sale in
 * progress, and the people who work the order queue are the people who chase
 * one. `customers:write` is required to email somebody, because that is the
 * permission that governs contacting a customer.
 *
 * Nothing here can change a cart's contents. Editing a shopper's basket behind
 * their back is not a thing a shop should be able to do, and there is no
 * endpoint for it.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { money } from '../catalogue/index.js'
import { notificationsService } from '../notifications/index.js'
import { settingsService } from '../settings/index.js'
import { cartsService } from './carts.service.js'
import { cartsRepository } from './carts.repository.js'
import { cartIdParam, cartListQuery } from './carts.validators.js'

export const cartsAdminRoutes: ExpressRouter = Router()

cartsAdminRoutes.get(
  '/carts',
  requirePermission('orders:read'),
  validate({ query: cartListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof cartListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const [{ currency }, result] = await Promise.all([
      settingsService.get(),
      cartsRepository.listForAdmin({
        limit,
        offset,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.q ? { query: filter.q } : {}),
        withItemsOnly: filter.withItemsOnly,
      }),
    ])

    return paginated(
      res,
      result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        customerId: row.customerId,
        // A guest cart has no account behind it, which is a fact about the
        // cart rather than a missing field.
        customerEmail: row.customerEmail,
        customerName: row.customerName,
        itemCount: row.itemCount,
        // The value at the prices the products carry *now*, which is what
        // recovering it would be worth today.
        value: money(row.valueCents, currency),
        lastActivityAt: row.lastActivityAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        convertedOrderId: row.convertedOrderId,
        createdAt: row.createdAt.toISOString(),
      })),
      buildPaginationMeta(filter, result.total),
      {
        // What the abandoned pile is worth in total, so the page does not sum
        // one page of rows and call it the number.
        abandonedValue: money(result.abandonedValueCents, currency),
        abandonedCount: result.abandonedCount,
      },
    )
  },
)

cartsAdminRoutes.get(
  '/carts/:id',
  requirePermission('orders:read'),
  validate({ params: cartIdParam }),
  async (req: Request, res: Response) => {
    const id = req.params.id as string
    // The same resolver the storefront uses, so what staff see is what the
    // shopper would see if they came back — including a line that is no
    // longer purchasable, which is often the reason they left.
    const resolved = await cartsService.resolve(id)
    const owner = await cartsRepository.ownerOf(id)

    return ok(res, {
      id: resolved.cart.id,
      status: resolved.cart.status,
      currency: resolved.cart.currency,
      customer: owner,
      lines: resolved.lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        sku: line.sku,
        imageUrl: line.imageUrl,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        purchasable: line.purchasable,
        /** Why it cannot be bought — often why the basket was left. */
        problem: line.problem,
      })),
      totals: resolved.totals,
      purchasable: resolved.purchasable,
      lastActivityAt: resolved.cart.lastActivityAt.toISOString(),
      expiresAt: resolved.cart.expiresAt.toISOString(),
      convertedOrderId: resolved.cart.convertedOrderId,
      createdAt: resolved.cart.createdAt.toISOString(),
    })
  },
)

/**
 * Emails the shopper a link back to their basket.
 *
 * Requires an address to send to, which a guest cart may not have — so the
 * refusal names that rather than failing silently. Queued through the same
 * pipeline as every other message the shop sends; nothing is sent inline.
 */
cartsAdminRoutes.post(
  '/carts/:id/recover',
  requirePermission('customers:write'),
  validate({ params: cartIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const result = await cartsService.sendRecovery(req.params.id as string, actor, {
      // The same consent the automatic sweep consults. A recovery email is
      // marketing however deliberately somebody pressed the button.
      allowed: (customerId) => notificationsService.allows(customerId, 'cart.abandoned', 'email'),
    })
    return accepted(res, result)
  },
)
