/**
 * Shipping configuration (§7.1, §6.6).
 *
 * Zones and methods are structural — they decide where the store will ship and
 * what it charges — so they sit behind `shipping:write`, which staff hold for
 * creating shipments and managers hold for changing the rate card.
 *
 * Methods are archived rather than deleted: past orders name the method they
 * were shipped by, and deleting the row would leave those orders citing
 * nothing.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { created, noContent, ok } from '../../shared/http/respond.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { shippingService } from './shipping.service.js'
import {
  createMethodSchema,
  createZoneSchema,
  idParam,
  updateMethodSchema,
  updateZoneSchema,
  zoneIdQuery,
  zoneListQuery,
} from './shipping.validators.js'

export const shippingAdminRoutes: ExpressRouter = Router()

shippingAdminRoutes.get(
  '/shipping/zones',
  requirePermission('shipping:read'),
  validate({ query: zoneListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof zoneListQuery>>(req)
    return ok(res, await shippingService.listZones({ includeArchived: filter.includeArchived }))
  },
)

shippingAdminRoutes.get(
  '/shipping/zones/:id',
  requirePermission('shipping:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    return ok(res, await shippingService.getZone(req.params.id as string))
  },
)

shippingAdminRoutes.post(
  '/shipping/zones',
  requirePermission('shipping:write'),
  validate({ body: createZoneSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createZoneSchema>
    const zone = await shippingService.createZone(body, actor)
    return created(res, zone, `/api/v1/admin/shipping/zones/${zone.id}`)
  },
)

shippingAdminRoutes.patch(
  '/shipping/zones/:id',
  requirePermission('shipping:write'),
  validate({ params: idParam, body: updateZoneSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const zone = await shippingService.updateZone(
      req.params.id as string,
      req.body as z.infer<typeof updateZoneSchema>,
      actor,
    )
    return ok(res, zone)
  },
)

/**
 * Archives a zone. Its methods are kept: orders cite them, and a `DELETE` would
 * cascade the rate card those orders were priced against out of existence.
 */
shippingAdminRoutes.delete(
  '/shipping/zones/:id',
  requirePermission('shipping:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await shippingService.archiveZone(req.params.id as string, actor)
    return noContent(res)
  },
)

shippingAdminRoutes.post(
  '/shipping/zones/:id/restore',
  requirePermission('shipping:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, await shippingService.restoreZone(req.params.id as string, actor))
  },
)

shippingAdminRoutes.get(
  '/shipping/methods',
  requirePermission('shipping:read'),
  validate({ query: zoneIdQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof zoneIdQuery>>(req)
    return ok(res, await shippingService.listMethods(filter.zoneId))
  },
)

shippingAdminRoutes.post(
  '/shipping/methods',
  requirePermission('shipping:write'),
  validate({ body: createMethodSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const method = await shippingService.createMethod(
      req.body as z.infer<typeof createMethodSchema>,
      actor,
    )
    return created(res, method, `/api/v1/admin/shipping/methods/${method.id}`)
  },
)

shippingAdminRoutes.patch(
  '/shipping/methods/:id',
  requirePermission('shipping:write'),
  validate({ params: idParam, body: updateMethodSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const method = await shippingService.updateMethod(
      req.params.id as string,
      req.body as Record<string, unknown>,
      actor,
    )
    return ok(res, method)
  },
)

shippingAdminRoutes.delete(
  '/shipping/methods/:id',
  requirePermission('shipping:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await shippingService.archiveMethod(req.params.id as string, actor)
    return noContent(res)
  },
)
