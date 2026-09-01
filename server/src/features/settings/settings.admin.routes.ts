/**
 * Store settings administration (§23.14).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { ValidationError } from '../../shared/errors/index.js'
import { mediaService } from '../media/index.js'
import { settingsService } from './settings.service.js'
import { updateSettingsSchema } from './settings.validators.js'
import type { StoreSettings } from './settings.types.js'

function toDto(settings: StoreSettings) {
  return {
    storeName: settings.storeName,
    contactEmail: settings.contactEmail,
    supportUrl: settings.supportUrl,
    supportPhone: settings.supportPhone,
    currency: settings.currency,
    timezone: settings.timezone,
    weightUnit: settings.weightUnit,
    taxRateBps: settings.taxRateBps,
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultLowStockThreshold: settings.defaultLowStockThreshold,
    orderNumberPrefix: settings.orderNumberPrefix,
    reservationTtlMinutes: settings.reservationTtlMinutes,
    guestCheckoutEnabled: settings.guestCheckoutEnabled,

    // The cash-on-delivery policy. Writable through this same route, so leaving
    // it out of the response made it settable but never readable — a settings
    // form could save a new ceiling and had no way to show the current one.
    codEnabled: settings.codEnabled,
    codMinSubtotalCents: settings.codMinSubtotalCents,
    codMaxSubtotalCents: settings.codMaxSubtotalCents,
    codFeeCents: settings.codFeeCents,
    codCountryCodes: settings.codCountryCodes,
    codRequiresAccount: settings.codRequiresAccount,
    codMaxOpenOrders: settings.codMaxOpenOrders,
    orderReservationHours: settings.orderReservationHours,

    logoMediaId: settings.logoMediaId,
    metadata: settings.metadata,
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
  }
}

export const settingsAdminRoutes: ExpressRouter = Router()

settingsAdminRoutes.get(
  '/settings',
  requirePermission('settings:read'),
  async (_req: Request, res: Response) => {
    return ok(res, toDto(await settingsService.get()))
  },
)

settingsAdminRoutes.patch(
  '/settings',
  requirePermission('settings:write'),
  validate({ body: updateSettingsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const patch = req.body as z.infer<typeof updateSettingsSchema>

    // A logo must be a real, fully-processed asset. Pointing settings at a
    // pending upload would publish bytes nothing has inspected.
    if (patch.logoMediaId) {
      const asset = await mediaService.getById(patch.logoMediaId)
      if (!asset) throw new ValidationError('That media asset does not exist')
      mediaService.assertReady(asset)
    }

    const updated = await settingsService.update(patch, actor, { ip: req.ip ?? null })
    return ok(res, toDto(updated))
  },
)
