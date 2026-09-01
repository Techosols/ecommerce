/**
 * Public delivery rates (§7.1).
 *
 * A shopper needs to know what delivery costs before they have an account, so
 * this is unauthenticated — but it is a *quote*, not a configuration read: it
 * returns the rates that apply to one destination and never the zone list, the
 * weight bands or which countries are covered by which zone.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { ok } from '../../shared/http/respond.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { settingsService } from '../settings/index.js'
import { money } from '../catalogue/index.js'
import { shippingService } from './shipping.service.js'
import { rateQuoteQuery } from './shipping.validators.js'

export const shippingStorefrontRoutes: ExpressRouter = Router()

shippingStorefrontRoutes.get(
  '/shipping/rates',
  validate({ query: rateQuoteQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof rateQuoteQuery>>(req)
    const { currency } = await settingsService.get()
    const rates = await shippingService.quote(filter)

    return ok(
      res,
      rates.map((rate) => ({
        id: rate.methodId,
        name: rate.name,
        description: rate.description,
        price: money(rate.amountCents, currency),
        estimatedDaysMin: rate.estimatedDaysMin,
        estimatedDaysMax: rate.estimatedDaysMax,
      })),
    )
  },
)
