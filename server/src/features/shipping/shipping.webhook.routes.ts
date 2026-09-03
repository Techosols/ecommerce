/**
 * Inbound courier callbacks (§7.1, §16.6).
 *
 * The fast half of tracking. `shipping.poll_tracking` asks every fifteen
 * minutes and is the floor; this is what makes "delivered" reach the customer
 * within seconds of the door closing, for the couriers that push.
 *
 * ── Who authenticates this ───────────────────────────────────────────────────
 *
 * The provider does, inside `parseWebhook`. That is unusual enough to be worth
 * stating plainly: couriers sign differently — some HMAC the body under a
 * header of their own choosing, some send a shared token, some use mutual TLS —
 * so there is no single check this route could perform. It hands over the raw
 * bytes and the headers and treats a throw as a refusal.
 *
 * The safety net is the registry: a provider declaring `tracking: true` with
 * neither `track` nor `parseWebhook` is rejected at startup, and a provider
 * without `parseWebhook` never reaches this route at all.
 *
 * ── Why the same 200s as the payment webhook ─────────────────────────────────
 *
 * For the same reason. A courier that gets a 4xx retries, often for days, and
 * an unknown tracking number is not something a retry will fix — a parcel this
 * shop never booked stays unknown however many times it is announced. So an
 * unrecognised or empty callback is answered "received", which says the message
 * arrived, not that anything was done with it.
 *
 * A bad signature is the exception: that is a 401, because it is the one case
 * where the sender should stop.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { getCarrier } from '../../infrastructure/carriers/index.js'
import { ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { AuthenticationError, NotFoundError } from '../../shared/errors/index.js'
import { carrierService } from './carrier.service.js'
import { applyTracking } from '../../jobs/shipping/pollTracking.job.js'

const log = createLogger('shipping.webhook')

export const shippingWebhookRoutes: ExpressRouter = Router()

shippingWebhookRoutes.post(
  '/carriers/:provider',
  validate({ params: z.strictObject({ provider: z.string().min(1).max(40) }) }),
  async (req: Request, res: Response) => {
    const named = req.params.provider as string
    const carrier = getCarrier()

    /*
     * The provider in the path must be the one this shop is configured with.
     *
     * Not decoration: a shop that has moved from one courier to another still
     * has the old courier's callback URL registered somewhere, and honouring it
     * would mean parsing a stranger's payload with the new courier's signing
     * secret. A 404 is also the honest answer — this shop has no such webhook.
     */
    if (named !== carrier.name || !carrier.capabilities.tracking || !carrier.parseWebhook) {
      log.warn({ named, configured: carrier.name }, 'callback for a courier this shop does not use')
      throw new NotFoundError('No such webhook')
    }

    const raw = req.rawBody
    if (!raw) throw new AuthenticationError('Missing webhook body')

    let update
    try {
      update = carrier.parseWebhook(raw, req.headers as Record<string, string | undefined>)
    } catch (error) {
      // The provider rejected it — almost always the signature. Nothing about
      // why goes back to the sender.
      log.warn({ err: error, provider: carrier.name }, 'carrier webhook rejected')
      throw new AuthenticationError('Invalid webhook signature')
    }

    if (!update || update.events.length === 0) {
      log.debug({ provider: carrier.name }, 'carrier webhook carried nothing to record')
      return ok(res, { received: true, applied: false })
    }

    const shipment = await carrierService.shipmentByTracking(update.trackingNumber)
    if (!shipment) {
      // Signed by our courier, about a parcel that is not ours. Worth a log line
      // and nothing else: retrying will not make it ours.
      log.warn(
        { provider: carrier.name, trackingNumber: update.trackingNumber },
        'carrier webhook for an unknown parcel',
      )
      return ok(res, { received: true, applied: false })
    }

    /*
     * Straight through `applyTracking`, exactly as the poll does.
     *
     * Deliberately synchronous rather than enqueued: the work is one insert per
     * scan and at most one status transition, the uniqueness constraint makes a
     * redelivery a no-op, and doing it here means a courier that pushes and is
     * also polled cannot produce two different answers. If this ever grows
     * expensive it becomes a job — but then the poll must become one too, and
     * both must still converge.
     */
    const advanced = await applyTracking(shipment.id, carrier.name, update.events)

    log.info(
      {
        provider: carrier.name,
        shipmentId: shipment.id,
        trackingNumber: update.trackingNumber,
        events: update.events.length,
        advanced,
      },
      'carrier webhook applied',
    )

    return ok(res, { received: true, applied: advanced })
  },
)
