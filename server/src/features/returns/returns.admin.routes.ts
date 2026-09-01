/**
 * Return administration (§7.1, §6.6).
 *
 * The routes are the moves in the lifecycle, one endpoint each, rather than a
 * `PATCH /returns/:id` that would let somebody set `status: 'closed'` on a
 * return nothing had ever arrived for.
 *
 * Two permissions, and one route that needs both:
 *
 *   `returns:read`   see returns and what is on them
 *   `returns:write`  approve, decline, receive, cancel and close
 *   + `payments:refund` on the one route that also sends money
 *
 * Deciding goods may come back and deciding to pay for them are two approvals.
 * Somebody who can receive a parcel should not be able to issue a refund by
 * pressing a different button on the same page.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created as created_, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requireAllPermissions, requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { returnsService } from './returns.service.js'
import { adminReturnDto, returnCardDto } from './returns.mapper.js'
import {
  openReturnSchema,
  receiveReturnSchema,
  refundReturnSchema,
  returnIdParam,
  returnListQuery,
  staffNoteSchema,
} from './returns.validators.js'
import { RETURN_CONDITIONS, RETURN_REASONS, RETURN_STATUSES } from './returns.types.js'

export const returnsAdminRoutes: ExpressRouter = Router()

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The returns queue.
 *
 * The enums travel with the list so the client's filter and its condition
 * picker are built from the server's own vocabulary rather than a copy that
 * drifts the first time a value is added.
 */
returnsAdminRoutes.get(
  '/returns',
  requirePermission('returns:read'),
  validate({ query: returnListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof returnListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { rows, total } = await returnsService.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.orderId ? { orderId: filter.orderId } : {}),
      limit,
      offset,
    })

    return paginated(res, rows.map(returnCardDto), buildPaginationMeta(filter, total), {
      statuses: RETURN_STATUSES,
      reasons: RETURN_REASONS,
      conditions: RETURN_CONDITIONS,
    })
  },
)

returnsAdminRoutes.get(
  '/returns/:id',
  requirePermission('returns:read'),
  validate({ params: returnIdParam }),
  async (req: Request, res: Response) => {
    return ok(res, adminReturnDto(await returnsService.detail(req.params.id as string)))
  },
)

/** What can still be sent back on an order — what a new return is built from. */
returnsAdminRoutes.get(
  '/orders/:id/returnable',
  requirePermission('returns:read'),
  validate({ params: returnIdParam }),
  async (req: Request, res: Response) => {
    return ok(res, await returnsService.returnable(req.params.id as string))
  },
)

/** Every return opened against one order, for the order page. */
returnsAdminRoutes.get(
  '/orders/:id/returns',
  requirePermission('returns:read'),
  validate({ params: returnIdParam }),
  async (req: Request, res: Response) => {
    const rows = await returnsService.forOrder(req.params.id as string)
    return ok(res, rows.map(returnCardDto))
  },
)

// ── Opening ─────────────────────────────────────────────────────────────────

/** Staff open returns on the phone every day; this is that. */
returnsAdminRoutes.post(
  '/orders/:id/returns',
  requirePermission('returns:write'),
  validate({ params: returnIdParam, body: openReturnSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof openReturnSchema>
    const created = await returnsService.request(
      req.params.id as string,
      {
        reason: body.reason,
        customerNote: body.customerNote ?? null,
        lines: body.lines,
      },
      actor,
    )
    return created_(res, adminReturnDto(created))
  },
)

// ── Moving it along ─────────────────────────────────────────────────────────

/**
 * The four plain moves, declared from one table.
 *
 * Written as a loop rather than four near-identical handlers because the only
 * thing that differs is the target state — and four copies of the same eight
 * lines is four places for them to drift.
 */
for (const [path, target] of [
  ['approve', 'approved'],
  ['decline', 'declined'],
  ['in-transit', 'in_transit'],
  ['cancel', 'cancelled'],
] as const) {
  returnsAdminRoutes.post(
    `/returns/:id/${path}`,
    requirePermission('returns:write'),
    validate({ params: returnIdParam, body: staffNoteSchema }),
    async (req: Request, res: Response) => {
      const actor = requireActor(req)
      const body = req.body as z.infer<typeof staffNoteSchema>
      const updated = await returnsService.transition(
        req.params.id as string,
        target,
        { staffNote: body.staffNote ?? null },
        actor,
      )
      return ok(res, adminReturnDto(updated))
    },
  )
}

/** Closing without a refund — an exchange, or a replacement sent out. */
returnsAdminRoutes.post(
  '/returns/:id/close',
  requirePermission('returns:write'),
  validate({ params: returnIdParam, body: staffNoteSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof staffNoteSchema>
    const updated = await returnsService.transition(
      req.params.id as string,
      'closed',
      { staffNote: body.staffNote ?? null },
      actor,
    )
    return ok(res, adminReturnDto(updated))
  },
)

/**
 * Records what arrived, per line and per condition.
 *
 * Only resellable units go back on the shelf, and the service decides that from
 * the condition rather than taking a restock quantity from the client.
 */
returnsAdminRoutes.post(
  '/returns/:id/receive',
  requirePermission('returns:write'),
  validate({ params: returnIdParam, body: receiveReturnSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof receiveReturnSchema>
    const updated = await returnsService.receive(
      req.params.id as string,
      { lines: body.lines, staffNote: body.staffNote ?? null },
      actor,
    )
    return ok(res, adminReturnDto(updated))
  },
)

/** Refunds what came back and closes the return. Needs both approvals. */
returnsAdminRoutes.post(
  '/returns/:id/refund',
  requireAllPermissions('returns:write', 'payments:refund'),
  validate({ params: returnIdParam, body: refundReturnSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof refundReturnSchema>
    const updated = await returnsService.refund(
      req.params.id as string,
      {
        paymentId: body.paymentId,
        amountCents: body.amountCents,
        reason: body.reason ?? null,
        staffNote: body.staffNote ?? null,
      },
      actor,
    )
    return ok(res, adminReturnDto(updated))
  },
)
