/**
 * Notification routes (§7.1).
 *
 * The same shape is mounted on both surfaces, because the authorisation rule is
 * identical on each: **you may read your own notifications and nobody else's.**
 * The scoping is the Actor's id, taken from the verified token — never an id in
 * the URL — so there is no route here that could name another person's inbox.
 *
 * Staff notifications are the same rows with `audience = 'staff'`; a staff
 * member reads them through the admin mount, which already requires staff.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { noContent, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { authenticate, requireActor } from '../../shared/middleware/authenticate.js'
import { notificationsService } from './notifications.service.js'
import { notificationDto } from './notifications.mapper.js'
import { idParam, notificationListQuery, setPreferenceSchema } from './notifications.validators.js'

/**
 * Builds the route table. Both surfaces get their own Router instance rather
 * than sharing one, because Express mounts middleware per router and the admin
 * surface already carries `authenticate()` from the composition root.
 */
function buildRoutes(options: { authenticated: boolean }): ExpressRouter {
  const routes = Router()
  // On the storefront the guard is added here; on the admin surface it is
  // already applied globally, and applying it twice would re-verify the token
  // on every request for nothing.
  const guard = options.authenticated ? [] : [authenticate()]

  routes.get(
    '/notifications',
    ...guard,
    validate({ query: notificationListQuery }),
    async (req: Request, res: Response) => {
      const actor = requireActor(req)
      const filter = validatedQuery<{ page: number; limit: number; unread: boolean }>(req)
      const { limit, offset } = toOffset(filter)
      const { rows, total } = await notificationsService.list(actor.userId, {
        limit,
        offset,
        unreadOnly: filter.unread,
      })
      return paginated(res, rows.map(notificationDto), buildPaginationMeta(filter, total))
    },
  )

  /** The unread badge, on its own so a header does not fetch a whole page. */
  routes.get('/notifications/unread-count', ...guard, async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, { count: await notificationsService.unreadCount(actor.userId) })
  })

  routes.post(
    '/notifications/:id/read',
    ...guard,
    validate({ params: idParam }),
    async (req: Request, res: Response) => {
      const actor = requireActor(req)
      // Scoped by owner inside the service: marking somebody else's is a 404,
      // which is also what stops this route confirming that an id exists.
      await notificationsService.markRead(actor.userId, req.params.id as string)
      return noContent(res)
    },
  )

  routes.post('/notifications/read-all', ...guard, async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, { marked: await notificationsService.markAllRead(actor.userId) })
  })

  // ── Preferences ───────────────────────────────────────────────────────────
  //
  // An absent row means enabled, so this list is the exceptions a person has
  // set, not an exhaustive matrix that would need backfilling whenever a new
  // notification type is added.

  routes.get('/notifications/preferences', ...guard, async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, await notificationsService.listPreferences(actor.userId))
  })

  routes.put(
    '/notifications/preferences',
    ...guard,
    validate({ body: setPreferenceSchema }),
    async (req: Request, res: Response) => {
      const actor = requireActor(req)
      const body = req.body as z.infer<typeof setPreferenceSchema>
      await notificationsService.setPreference(actor.userId, body.type, body.channel, body.enabled)
      return ok(res, body)
    },
  )

  return routes
}

export const notificationsStorefrontRoutes: ExpressRouter = buildRoutes({ authenticated: false })
export const notificationsAdminRoutes: ExpressRouter = buildRoutes({ authenticated: true })
