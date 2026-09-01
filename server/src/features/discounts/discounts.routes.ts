/**
 * Checking a discount code (§7.1).
 *
 * One route, and it is a *check*, not a lookup: the caller sends a code and
 * gets back what it is worth against their own cart. There is deliberately no
 * `GET /discounts` on this surface — listing every live code would turn the
 * store's promotions into a public price list, and a code that could be
 * enumerated is not a code.
 *
 * The subtotal comes from the caller's cart, resolved server-side. Accepting a
 * subtotal in the request would let anyone ask "what would this be worth on a
 * £10,000 basket?" and, worse, would be the number the discount was computed
 * against.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { authenticateOptional } from '../../shared/middleware/authenticate.js'
import { ValidationError } from '../../shared/errors/index.js'
import { money } from '../catalogue/index.js'
import { cartsService } from '../carts/index.js'
import { CART_COOKIE_NAME } from '../carts/carts.routes.js'
import { discountsService } from './discounts.service.js'
import { quoteDiscountSchema } from './discounts.validators.js'

export const discountsStorefrontRoutes: ExpressRouter = Router()

discountsStorefrontRoutes.post(
  '/discounts/check',
  authenticateOptional(),
  validate({ body: quoteDiscountSchema }),
  async (req: Request, res: Response) => {
    const customerId = req.actor?.userId ?? null
    const anonymousToken = (req.cookies?.[CART_COOKIE_NAME] as string | undefined) ?? null
    const cart = await cartsService.find({ customerId, anonymousToken })
    if (!cart) throw new ValidationError('There is nothing in your cart')

    const resolved = await cartsService.resolve(cart.id)
    const body = req.body as z.infer<typeof quoteDiscountSchema>

    // Every refusal has its own error code — expired, used up, needs an
    // account, minimum not met — because "invalid coupon" is the message that
    // generates support tickets.
    const quote = await discountsService.quote({
      code: body.code,
      subtotalCents: resolved.totals.subtotal.amount,
      customerId,
      // Scoped codes are worth only what they cover, so the basket goes with
      // the question.
      lines: resolved.lines.map((line) => ({
        productId: line.productId,
        lineTotalCents: line.lineTotal.amount,
      })),
    })

    return ok(res, {
      code: quote.code,
      type: quote.type,
      amount: money(quote.amountCents, resolved.cart.currency),
      freeShipping: quote.freeShipping,
    })
  },
)
