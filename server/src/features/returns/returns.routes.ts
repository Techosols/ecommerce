/**
 * The customer's own returns (§7.1).
 *
 * Every route here is scoped to the caller. A return is read by asking for it
 * and being its owner — never by an id alone, which order numbers and sequences
 * make guessable. A return that does not belong to the caller answers 404
 * rather than 403, because "that exists but is not yours" is itself a fact
 * about somebody else's shopping.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { authenticate, requireActor } from '../../shared/middleware/authenticate.js'
import { ipLimiter } from '../../shared/middleware/rateLimit.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { ordersService } from '../orders/index.js'
import { returnsService } from './returns.service.js'
import { customerReturnDto, returnCardDto } from './returns.mapper.js'
import {
  guestOpenReturnSchema,
  guestOrderClaimSchema,
  myReturnListQuery,
  openReturnSchema,
  returnIdParam,
} from './returns.validators.js'

export const returnsStorefrontRoutes: ExpressRouter = Router()

/*
 * `authenticate()` sits on each route rather than on the router.
 *
 * A router-level `use()` with no path runs for every storefront request that
 * reaches this router — including requests destined for the routers mounted
 * after it — so a blanket guard here would 401 anonymous calls to the cart and
 * the catalogue. Per-route is the only placement that guards these routes and
 * only these routes.
 */

/*
 * ── The same two things, for somebody with no account ──────────────────────
 *
 * A guest checkout is most of this shop's orders, and until now a guest who
 * needed to send something back had no route at all — they had to email. These
 * two carry the order number and the email it was placed with, resolved through
 * the same `lookupGuestOrder` the order lookup uses, which matches only orders
 * with no password on the account. A registered customer's order is therefore
 * unreachable here whatever number is guessed, and the rate limit is the
 * lookup's.
 *
 * POST for both, including the read: an email address in a query string ends up
 * in access logs, browser history and the `Referer` of every asset the page
 * then loads.
 */

const guestLimiter = ipLimiter({ windowMs: 15 * 60_000, limit: 10 })

/** What a guest can still send back. */
returnsStorefrontRoutes.post(
  '/orders/lookup/returnable',
  guestLimiter,
  validate({ body: guestOrderClaimSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof guestOrderClaimSchema>
    const order = await ordersService.lookupGuestOrder(body.orderNumber, body.email)
    return ok(res, await returnsService.returnable(order.id))
  },
)

returnsStorefrontRoutes.post(
  '/orders/lookup/returns',
  guestLimiter,
  validate({ body: guestOpenReturnSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof guestOpenReturnSchema>
    const order = await ordersService.lookupGuestOrder(body.orderNumber, body.email)

    const request = await returnsService.request(
      order.id,
      { reason: body.reason, customerNote: body.customerNote ?? null, lines: body.lines },
      null,
    )
    return created(res, customerReturnDto(request))
  },
)

returnsStorefrontRoutes.get(
  '/returns',
  authenticate(),
  validate({ query: myReturnListQuery }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const filter = validatedQuery<z.infer<typeof myReturnListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { rows, total } = await returnsService.list({
      customerId: actor.userId,
      limit,
      offset,
    })
    return paginated(res, rows.map(returnCardDto), buildPaginationMeta(filter, total))
  },
)

returnsStorefrontRoutes.get(
  '/returns/:id',
  authenticate(),
  validate({ params: returnIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const request = await returnsService.detail(req.params.id as string)
    if (request.customerId !== actor.userId) throw new NotFoundError('Return not found')
    return ok(res, customerReturnDto(request))
  },
)

/** What the customer can still send back from one of their own orders. */
returnsStorefrontRoutes.get(
  '/orders/:id/returnable',
  authenticate(),
  validate({ params: returnIdParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    // Ownership is checked by the order service, which 404s an order that is
    // not this customer's — so the returnable read cannot be used to probe.
    await ordersService.detailForCustomer(req.params.id as string, actor.userId)
    return ok(res, await returnsService.returnable(req.params.id as string))
  },
)

returnsStorefrontRoutes.post(
  '/orders/:id/returns',
  authenticate(),
  validate({ params: returnIdParam, body: openReturnSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof openReturnSchema>
    await ordersService.detailForCustomer(req.params.id as string, actor.userId)

    const request = await returnsService.request(
      req.params.id as string,
      { reason: body.reason, customerNote: body.customerNote ?? null, lines: body.lines },
      null,
    )
    return created(res, customerReturnDto(request))
  },
)
