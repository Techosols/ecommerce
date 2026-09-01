/**
 * Checkout and a customer's own orders (§7.1).
 *
 * Two scoping rules, both structural rather than remembered:
 *
 *   • The cart is taken from the session or the guest cookie, never from the
 *     body, so nobody can check out somebody else's basket.
 *   • Order reads go through `detailForCustomer`, which matches on the owner —
 *     a signed-in customer asking for another customer's order gets a 404, and
 *     a guest gets nothing at all.
 *
 * Guests may buy: checkout is `authenticateOptional()`. What a guest may not do
 * is list orders, because there is no verified identity to list them for.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { authenticate, authenticateOptional, requireActor } from '../../shared/middleware/authenticate.js'
import { idempotency } from '../../shared/middleware/idempotency.js'
import { ipLimiter } from '../../shared/middleware/rateLimit.js'
import { NotFoundError, ValidationError } from '../../shared/errors/index.js'
import { money } from '../catalogue/index.js'
import { cartsService } from '../carts/index.js'
import { CART_COOKIE_NAME } from '../carts/carts.routes.js'
import { checkoutAttemptsService } from './checkoutAttempts.service.js'
import { checkoutService } from './checkout.service.js'
import { ordersService } from './orders.service.js'
import { customerOrderCardDto, customerOrderDto } from './orders.mapper.js'
import {
  cancelOrderSchema,
  checkoutSchema,
  guestOrderLookupSchema,
  idParam,
  myOrderListQuery,
} from './orders.validators.js'
import { checkoutPreviewQuery } from './checkout.validators.js'

export const ordersStorefrontRoutes: ExpressRouter = Router()

/**
 * Finds the caller's active cart the same way `/cart` does.
 *
 * Returning 422 rather than 404 when there is none is deliberate: an empty
 * checkout is a request that cannot be satisfied, not a missing resource.
 */
async function activeCartId(req: Request): Promise<string> {
  const customerId = req.actor?.userId ?? null
  const anonymousToken = (req.cookies?.[CART_COOKIE_NAME] as string | undefined) ?? null
  const cart = await cartsService.find({ customerId, anonymousToken })
  if (!cart) throw new ValidationError('There is nothing in your cart')
  return cart.id
}

/** What checkout would cost. Runs the real rating code, so it cannot drift. */
ordersStorefrontRoutes.get(
  '/checkout/preview',
  authenticateOptional(),
  validate({ query: checkoutPreviewQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof checkoutPreviewQuery>>(req)
    const preview = await checkoutService.preview({
      cartId: await activeCartId(req),
      countryCode: filter.countryCode,
      shippingMethodId: filter.shippingMethodId ?? null,
      discountCode: filter.discountCode ?? null,
      paymentMethod: filter.paymentMethod ?? null,
      customerId: req.actor?.userId ?? null,
    })

    return ok(res, {
      subtotal: money(preview.subtotalCents, preview.currency),
      discountTotal: money(preview.discountTotalCents, preview.currency),
      shippingTotal: money(preview.shippingTotalCents, preview.currency),
      shippingOptions: preview.shippingOptions.map((option) => ({
        id: option.methodId,
        name: option.name,
        description: option.description,
        price: money(option.amountCents, preview.currency),
        estimatedDaysMin: option.estimatedDaysMin,
        estimatedDaysMax: option.estimatedDaysMax,
      })),
      selectedShippingMethodId: preview.selectedShippingMethodId,
      // Tax and the total were computed here all along and simply not
      // published. A checkout that cannot show what will be charged is not a
      // checkout, and a storefront adding these up itself would be a second
      // implementation of the arithmetic that the till actually uses.
      taxTotal: money(preview.taxTotalCents, preview.currency),
      total: money(preview.totalCents, preview.currency),
      paymentFee: money(preview.paymentFeeCents, preview.currency),
      // Only the methods this basket may actually use. A method that is not
      // listed here will be refused at checkout, and the reasons why are not
      // published — they are the store's abuse controls (§23.1).
      paymentMethods: preview.paymentMethods.map((method) => ({
        key: method.key,
        label: method.label,
        description: method.description,
        fee: money(method.feeCents, preview.currency),
      })),
      selectedPaymentMethod: preview.selectedPaymentMethod,
      discount: preview.discount
        ? {
            code: preview.discount.code,
            type: preview.discount.type,
            amount: money(preview.discount.amountCents, preview.currency),
          }
        : null,
      purchasable: preview.purchasable,
    })
  },
)

/**
 * Places the order.
 *
 * Idempotent by key: a double-tapped "Pay" button, or a retry after a dropped
 * connection, must not produce two orders and two stock reservations (§7.6).
 */
ordersStorefrontRoutes.post(
  '/checkout',
  authenticateOptional(),
  idempotency(),
  validate({ body: checkoutSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof checkoutSchema>
    const cartId = await activeCartId(req)

    // Read before the attempt, because a failure destroys nothing but a
    // success converts the cart — and a log row saying "0 items" for every
    // sale would be worse than no log at all.
    const basket = await cartsService.resolve(cartId)
    const attempt = {
      cartId,
      customerId: req.actor?.userId ?? null,
      email: body.email.toLowerCase(),
      paymentMethod: body.paymentMethod,
      countryCode: body.shippingAddress.countryCode,
      subtotalCents: basket.totals.subtotal.amount,
      itemCount: basket.lines.reduce((sum, line) => sum + line.quantity, 0),
    }

    let order
    try {
      order = await checkoutService.place(
        {
          cartId,
          email: body.email,
          paymentMethod: body.paymentMethod,
          phone: body.phone ?? null,
          shippingAddress: body.shippingAddress,
          ...(body.billingAddress ? { billingAddress: body.billingAddress } : {}),
          shippingMethodId: body.shippingMethodId ?? null,
          discountCode: body.discountCode ?? null,
          customerNote: body.customerNote ?? null,
        },
        { customerId: req.actor?.userId ?? null, source: 'storefront', actor: req.actor ?? null },
      )
    } catch (error) {
      // Recorded and re-thrown unchanged: the shopper gets exactly the refusal
      // they got before this log existed.
      await checkoutAttemptsService.recordFailure(attempt, error)
      throw error
    }

    await checkoutAttemptsService.recordPlaced(attempt, order.id)

    // The basket is now an order, so the guest cookie has nothing left to point
    // at; clearing it stops the next visit resuming a converted cart.
    res.clearCookie(CART_COOKIE_NAME, { path: '/' })
    return created(res, customerOrderDto(order), `/api/v1/storefront/orders/${order.id}`)
  },
)

/**
 * A guest finding their own order again.
 *
 * Without this a guest checkout is a one-way door: the 201 response is the only
 * time they ever see their order, and closing the tab loses it.
 *
 * Three things make it safe enough to be public:
 *
 *   • it needs the order number **and** the email it was placed with
 *   • it only ever matches orders with no account attached — order numbers come
 *     from a sequence and are guessable, so without that restriction anyone who
 *     knew a customer's address could walk the numbers and read their history
 *   • it is rate limited well below what guessing would need, and every failure
 *     returns the same 404, so it cannot be used to discover which numbers
 *     exist or which addresses have shopped here
 *
 * POST rather than GET because an email address in a URL ends up in access
 * logs, browser history and the `Referer` of every asset the page then loads.
 */
ordersStorefrontRoutes.post(
  '/orders/lookup',
  ipLimiter({ windowMs: 15 * 60_000, limit: 10 }),
  validate({ body: guestOrderLookupSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof guestOrderLookupSchema>
    const order = await ordersService.lookupGuestOrder(body.orderNumber, body.email)
    return ok(res, customerOrderDto(order))
  },
)

// ── A customer's own orders ─────────────────────────────────────────────────

ordersStorefrontRoutes.get(
  '/orders',
  authenticate(),
  validate({ query: myOrderListQuery }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const filter = validatedQuery<z.infer<typeof myOrderListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { rows, total } = await ordersService.list({ customerId: actor.userId, limit, offset })
    return paginated(res, rows.map(customerOrderCardDto), buildPaginationMeta(filter, total))
  },
)

ordersStorefrontRoutes.get(
  '/orders/:id',
  authenticate(),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const order = await ordersService.detailForCustomer(req.params.id as string, actor.userId)
    return ok(res, customerOrderDto(order))
  },
)

/**
 * A customer cancelling their own order.
 *
 * Only while it is still theirs to cancel: the ownership check comes first, and
 * the service refuses anything already shipped. Stock always goes back — a
 * customer is not offered the "keep it off the shelf" choice staff have.
 */
ordersStorefrontRoutes.post(
  '/orders/:id/cancel',
  authenticate(),
  validate({ params: idParam, body: cancelOrderSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const orderId = req.params.id as string
    const order = await ordersService.detailForCustomer(orderId, actor.userId)
    if (order.status !== 'pending' && order.status !== 'confirmed') {
      throw new NotFoundError('That order can no longer be cancelled')
    }

    const body = req.body as z.infer<typeof cancelOrderSchema>
    const cancelled = await ordersService.cancel(
      orderId,
      { reason: body.reason ?? 'Cancelled by the customer', restock: true },
      actor,
      'customer',
    )
    return ok(res, customerOrderDto(cancelled))
  },
)
