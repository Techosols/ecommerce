/**
 * Inventory administration (§7.1, §6.6).
 *
 * The routes are stock operations, not table rows. There is no
 * `PATCH /levels/:id` that would let someone set a number: every change to
 * `on_hand` goes through `POST /inventory/adjustments` or
 * `POST /inventory/stocktake`, both of which record why.
 *
 * Three permissions, because three different kinds of decision:
 *
 *   `inventory:read`     see stock and its history
 *   `inventory:adjust`   move stock (day-to-day; staff hold this)
 *   `inventory:transfer` move stock between locations
 *   `inventory:manage`   locations and tracking policy (structural; not staff)
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted, created, noContent, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { defaultThreshold, inventoryService } from './inventory.service.js'
import { locationsService } from './locations.service.js'
import { reservationsService } from './reservations.service.js'
import {
  adminInventoryItemDto,
  adminItemSummaryDto,
  adminLocationDto,
  adminMovementDto,
  adminReservationDto,
} from './inventory.mapper.js'
import {
  adjustmentSchema,
  createLocationSchema,
  idParam,
  itemListQuery,
  movementListQuery,
  reserveSchema,
  stocktakeSchema,
  transferSchema,
  updateItemSchema,
  updateLocationSchema,
  variantParam,
} from './inventory.validators.js'

export const inventoryAdminRoutes: ExpressRouter = Router()

// ── Locations ───────────────────────────────────────────────────────────────

inventoryAdminRoutes.get(
  '/locations',
  requirePermission('inventory:read'),
  async (_req: Request, res: Response) => {
    const locations = await locationsService.list()
    return ok(res, locations.map(adminLocationDto))
  },
)

inventoryAdminRoutes.post(
  '/locations',
  requirePermission('inventory:manage'),
  validate({ body: createLocationSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const location = await locationsService.create(
      req.body as z.infer<typeof createLocationSchema>,
      actor,
    )
    return created(res, adminLocationDto(location), `/api/v1/admin/locations/${location.id}`)
  },
)

inventoryAdminRoutes.patch(
  '/locations/:id',
  requirePermission('inventory:manage'),
  validate({ params: idParam, body: updateLocationSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const location = await locationsService.update(
      req.params.id as string,
      req.body as z.infer<typeof updateLocationSchema>,
      actor,
    )
    return ok(res, adminLocationDto(location))
  },
)

inventoryAdminRoutes.delete(
  '/locations/:id',
  requirePermission('inventory:manage'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await locationsService.archive(req.params.id as string, actor)
    return noContent(res)
  },
)

// ── Inventory items and levels ──────────────────────────────────────────────

inventoryAdminRoutes.get(
  '/inventory',
  requirePermission('inventory:read'),
  validate({ query: itemListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof itemListQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await inventoryService.listItems({
      limit,
      offset,
      lowOnly: filter.low,
      ...(filter.tracked ? { tracked: filter.tracked === 'true' } : {}),
      ...(filter.q ? { query: filter.q } : {}),
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
    })

    // The threshold travels with the rows so "is this low" is answered once, on
    // the server, rather than by each screen deciding for itself.
    const threshold = await defaultThreshold()
    return paginated(
      res,
      rows.map((row) => adminItemSummaryDto(row, threshold)),
      buildPaginationMeta(filter, total),
      { defaultLowStockThreshold: threshold },
    )
  },
)

inventoryAdminRoutes.get(
  '/inventory/items/:id',
  requirePermission('inventory:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const detail = await inventoryService.getItem(req.params.id as string)
    return ok(res, adminInventoryItemDto(detail))
  },
)

/** Convenience for the catalogue screen, which holds a variant id, not an item id. */
inventoryAdminRoutes.get(
  '/inventory/variants/:variantId',
  requirePermission('inventory:read'),
  validate({ params: variantParam }),
  async (req: Request, res: Response) => {
    const detail = await inventoryService.getItemForVariant(req.params.variantId as string)
    return ok(res, adminInventoryItemDto(detail))
  },
)

/** Tracking policy. Structural, so `inventory:manage` rather than `:adjust`. */
inventoryAdminRoutes.patch(
  '/inventory/items/:id',
  requirePermission('inventory:manage'),
  validate({ params: idParam, body: updateItemSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const detail = await inventoryService.updateItem(
      req.params.id as string,
      req.body as z.infer<typeof updateItemSchema>,
      actor,
    )
    return ok(res, adminInventoryItemDto(detail))
  },
)

/** What is holding this item's stock right now. */
inventoryAdminRoutes.get(
  '/inventory/items/:id/reservations',
  requirePermission('inventory:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const reservations = await inventoryService.reservationsFor(req.params.id as string)
    return ok(
      res,
      reservations.map((reservation) => ({
        ...adminReservationDto(reservation),
        orderNumber: reservation.orderNumber,
      })),
    )
  },
)

inventoryAdminRoutes.get(
  '/inventory/items/:id/history',
  requirePermission('inventory:read'),
  validate({ params: idParam, query: movementListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof movementListQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await inventoryService.history({
      inventoryItemId: req.params.id as string,
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
      ...(filter.reason ? { reason: filter.reason } : {}),
      limit,
      offset,
    })
    return paginated(res, rows.map(adminMovementDto), buildPaginationMeta(filter, total))
  },
)

// ── Movements ───────────────────────────────────────────────────────────────

/**
 * The only way `on_hand` changes: a signed delta with a reason.
 *
 * Not `PUT /levels/:id` with a number — that races with concurrent movements
 * and leaves nobody able to answer why the figure is what it is.
 */
inventoryAdminRoutes.post(
  '/inventory/adjustments',
  requirePermission('inventory:adjust'),
  validate({ body: adjustmentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof adjustmentSchema>
    const level = await inventoryService.adjust(body, actor)

    return created(res, {
      inventoryItemId: level.inventoryItemId,
      locationId: level.locationId,
      onHand: level.onHand,
      reserved: level.reserved,
      available: level.available,
    })
  },
)

/** A physical count, recorded as the delta it implies. */
inventoryAdminRoutes.post(
  '/inventory/stocktake',
  requirePermission('inventory:adjust'),
  validate({ body: stocktakeSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const level = await inventoryService.stocktake(
      req.body as z.infer<typeof stocktakeSchema>,
      actor,
    )
    return created(res, {
      inventoryItemId: level.inventoryItemId,
      locationId: level.locationId,
      onHand: level.onHand,
      available: level.available,
    })
  },
)

inventoryAdminRoutes.post(
  '/inventory/transfers',
  requirePermission('inventory:transfer'),
  validate({ body: transferSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof transferSchema>
    const { from, to } = await inventoryService.transfer(body, actor)

    return created(res, {
      from: { locationId: from.locationId, onHand: from.onHand, available: from.available },
      to: { locationId: to.locationId, onHand: to.onHand, available: to.available },
    })
  },
)

// ── Reservations ────────────────────────────────────────────────────────────
//
// Exposed for operations and for testing the seam the checkout will use. Carts
// and orders will call the service directly rather than looping through HTTP.

inventoryAdminRoutes.post(
  '/inventory/reservations',
  requirePermission('inventory:adjust'),
  validate({ body: reserveSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const reservation = await reservationsService.reserve(
      req.body as z.infer<typeof reserveSchema>,
      actor,
    )
    return created(res, adminReservationDto(reservation))
  },
)

inventoryAdminRoutes.get(
  '/inventory/reservations/:id',
  requirePermission('inventory:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const reservation = await reservationsService.getById(req.params.id as string)
    if (!reservation) throw new NotFoundError('Reservation not found')
    return ok(res, adminReservationDto(reservation))
  },
)

inventoryAdminRoutes.post(
  '/inventory/reservations/:id/release',
  requirePermission('inventory:adjust'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const reservation = await reservationsService.release(req.params.id as string, actor)
    return accepted(res, adminReservationDto(reservation))
  },
)

inventoryAdminRoutes.post(
  '/inventory/reservations/:id/commit',
  requirePermission('inventory:adjust'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const reservation = await reservationsService.commit(req.params.id as string, actor)
    return accepted(res, adminReservationDto(reservation))
  },
)
