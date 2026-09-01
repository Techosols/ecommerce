/**
 * Storefront settings (§23.14).
 *
 * A whitelisted public subset, built by an explicit mapper. The admin
 * serializer is never reused here — that is how a tax rate or an internal note
 * ends up on a public page.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { ok } from '../../shared/http/respond.js'
import { mediaService } from '../media/index.js'
import { settingsService } from './settings.service.js'

export const settingsStorefrontRoutes: ExpressRouter = Router()

settingsStorefrontRoutes.get('/settings', async (_req: Request, res: Response) => {
  const settings = await settingsService.get()
  const logoUrl = await mediaService.urlForId(settings.logoMediaId)
  return ok(res, settingsService.toPublic(settings, logoUrl))
})
