/**
 * Discount administration (§7.1, §6.6).
 *
 * `discounts:read` and `discounts:write` — and note that staff do *not* hold
 * either by default (§6.5). Creating money-off is a commercial decision, so it
 * sits with managers and the owner.
 *
 * Discounts are archived, never deleted: `order_discounts` records the code and
 * its terms as they were, and a deleted row would leave those orders citing a
 * discount nobody can look up.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, noContent, ok, paginated } from '../../shared/http/respond.js'
import {
  buildPaginationMeta,
  offsetPaginationQuery,
  toOffset,
} from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { settingsService } from '../settings/index.js'
import { money } from '../catalogue/index.js'
import { discountsService, type Discount } from './discounts.service.js'
import {
  createDiscountSchema,
  discountListQuery,
  idParam,
  updateDiscountSchema,
} from './discounts.validators.js'

/**
 * `usageCount` against `usageLimitTotal` is the number a manager actually wants
 * — "47 of 100 used" — so both travel together rather than making the console
 * compute a remaining figure that could disagree with the database's.
 */
function discountDto(
  discount: Discount,
  scope?: { productIds: string[]; categoryIds: string[] },
) {
  return {
    id: discount.id,
    code: discount.code,
    title: discount.title,
    type: discount.type,
    value: discount.value,
    appliesTo: discount.appliesTo,
    minSubtotalCents: discount.minSubtotalCents,
    startsAt: discount.startsAt?.toISOString() ?? null,
    endsAt: discount.endsAt?.toISOString() ?? null,
    usageLimitTotal: discount.usageLimitTotal,
    usageLimitPerCustomer: discount.usageLimitPerCustomer,
    usageCount: discount.usageCount,
    requiresCustomer: discount.requiresCustomer,
    isActive: discount.isActive,
    // Decided here rather than in the browser: six columns say whether a code
    // works, and a console that re-derived it would eventually disagree with
    // the eligibility check that actually refuses one.
    status: discountsService.statusOf(discount),
    archivedAt: discount.archivedAt?.toISOString() ?? null,
    createdAt: discount.createdAt.toISOString(),
    // Present on the detail read, absent from the list: a page of fifty codes
    // does not need five hundred product ids to render a row.
    ...(scope ? { productIds: scope.productIds, categoryIds: scope.categoryIds } : {}),
  }
}

export const discountsAdminRoutes: ExpressRouter = Router()

discountsAdminRoutes.get(
  '/discounts',
  requirePermission('discounts:read'),
  validate({ query: discountListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof discountListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { rows, total } = await discountsService.list({
      limit,
      offset,
      activeOnly: filter.active === 'true',
      includeArchived: filter.includeArchived,
      ...(filter.q ? { query: filter.q } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    })
    return paginated(res, rows.map((row) => discountDto(row)), buildPaginationMeta(filter, total))
  },
)

/**
 * One code's redemptions, newest first.
 *
 * Declared before `/discounts/:id` so the literal segment is matched as a
 * literal — a bug this file would otherwise be the fifth place to have.
 */
discountsAdminRoutes.get(
  '/discounts/:id/redemptions',
  requirePermission('discounts:read'),
  validate({ params: idParam, query: offsetPaginationQuery }),
  async (req: Request, res: Response) => {
    const pagination = validatedQuery<{ page: number; limit: number }>(req)
    const { limit, offset } = toOffset(pagination)
    const [{ currency }, { rows, total, totalAmountCents }] = await Promise.all([
      settingsService.get(),
      discountsService.redemptions({ discountId: req.params.id as string, limit, offset }),
    ])

    return paginated(
      res,
      rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        customerId: row.customerId,
        customerEmail: row.customerEmail,
        amount: money(row.amountCents, currency),
        createdAt: row.createdAt.toISOString(),
      })),
      buildPaginationMeta(pagination, total),
      // What the code has given away in total, so the page does not have to
      // sum a page of rows and call it the campaign's cost.
      { totalAmount: money(totalAmountCents, currency) },
    )
  },
)

discountsAdminRoutes.get(
  '/discounts/:id',
  requirePermission('discounts:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const id = req.params.id as string
    const [discount, scope] = await Promise.all([
      discountsService.getById(id),
      discountsService.scopeOf(id),
    ])
    return ok(res, discountDto(discount, scope))
  },
)

discountsAdminRoutes.post(
  '/discounts',
  requirePermission('discounts:write'),
  validate({ body: createDiscountSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const discount = await discountsService.create(
      req.body as z.infer<typeof createDiscountSchema>,
      actor,
    )
    const scope = await discountsService.scopeOf(discount.id)
    return created(res, discountDto(discount, scope), `/api/v1/admin/discounts/${discount.id}`)
  },
)

discountsAdminRoutes.patch(
  '/discounts/:id',
  requirePermission('discounts:write'),
  validate({ params: idParam, body: updateDiscountSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const discount = await discountsService.update(
      req.params.id as string,
      req.body as Record<string, unknown>,
      actor,
    )
    // With the scope, because a save that dropped it from the response would
    // leave the detail page re-rendering as though the discount covered
    // nothing.
    const scope = await discountsService.scopeOf(discount.id)
    return ok(res, discountDto(discount, scope))
  },
)

discountsAdminRoutes.delete(
  '/discounts/:id',
  requirePermission('discounts:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await discountsService.archive(req.params.id as string, actor)
    return noContent(res)
  },
)
