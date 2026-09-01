/**
 * Behavioural tracking (§7.1, §13).
 *
 * One write-only route. It returns 202 and nothing else: an analytics beacon
 * must never tell a caller what is in the table, and it must never fail a page.
 *
 * The user id is taken from the session when there is one and ignored when the
 * body supplies one — otherwise anyone could attribute events to anybody.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { authenticateOptional } from '../../shared/middleware/authenticate.js'
import { analyticsService } from './analytics.service.js'
import { trackEventSchema } from './analytics.validators.js'

export const analyticsStorefrontRoutes: ExpressRouter = Router()

analyticsStorefrontRoutes.post(
  '/analytics/events',
  authenticateOptional(),
  validate({ body: trackEventSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof trackEventSchema>
    await analyticsService.track({
      name: body.name,
      // From the verified token, never from the body.
      userId: req.actor?.userId ?? null,
      anonymousId: body.anonymousId ?? null,
      sessionId: body.sessionId ?? null,
      ...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
      properties: body.properties ?? {},
    })
    return accepted(res, { recorded: true })
  },
)
