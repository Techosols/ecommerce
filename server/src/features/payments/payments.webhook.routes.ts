/**
 * Inbound payment-provider callbacks (§7.1, §16.6).
 *
 * This is the one surface with no session, no cookie and no Actor, which makes
 * it the one that has to defend itself entirely on its own:
 *
 *   **Signature over the raw bytes.** `rawBodyJson()` keeps the exact buffer
 *   the provider sent, because a signature computed over re-serialised JSON
 *   verifies nothing. The comparison is `timingSafeEqual`, not `===`.
 *
 *   **No secret configured means no webhook.** With `PAYMENT_WEBHOOK_SECRET`
 *   unset, every request is refused rather than accepted unverified — an
 *   honoured unsigned webhook is an unauthenticated write to the payments
 *   table.
 *
 *   **Exactly-once by database constraint.** `(provider, provider_event_id)` is
 *   unique, so a redelivery — which every gateway does — is recognised and
 *   answered 200 without being processed twice.
 *
 *   **Always 200 for a duplicate or an unknown type.** A 4xx makes a provider
 *   retry forever; the response says "received", not "agreed".
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { env } from '../../config/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { ok } from '../../shared/http/respond.js'
import { validate } from '../../shared/middleware/validate.js'
import { AuthenticationError } from '../../shared/errors/index.js'
import { paymentsService } from './payments.service.js'

const log = createLogger('payments.webhook')

const SIGNATURE_HEADER = 'x-webhook-signature'

/**
 * The envelope every provider is adapted to before it reaches this route.
 *
 * Deliberately minimal: an id to deduplicate on, a type to dispatch on, and the
 * payload kept verbatim. Provider-specific shapes are a mapping problem, not a
 * reason to widen the schema.
 */
const webhookEnvelope = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(120),
  data: z.record(z.string(), z.unknown()).default({}),
})

function verifySignature(req: Request): void {
  const secret = env.PAYMENT_WEBHOOK_SECRET
  if (!secret) {
    log.warn('a payment webhook arrived but PAYMENT_WEBHOOK_SECRET is not configured')
    throw new AuthenticationError('Webhooks are not enabled')
  }

  const provided = req.get(SIGNATURE_HEADER)
  const raw = req.rawBody
  if (!provided || !raw) {
    throw new AuthenticationError('Missing webhook signature')
  }

  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided.trim(), 'utf8')

  // Length is compared first because `timingSafeEqual` throws on a mismatch —
  // and comparing lengths leaks nothing an attacker does not already control.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthenticationError('Invalid webhook signature')
  }
}

export const paymentsWebhookRoutes: ExpressRouter = Router()

paymentsWebhookRoutes.post(
  '/payments/:provider',
  validate({
    params: z.strictObject({ provider: z.string().min(1).max(40) }),
    body: webhookEnvelope,
  }),
  async (req: Request, res: Response) => {
    verifySignature(req)

    const provider = req.params.provider as string
    const body = req.body as z.infer<typeof webhookEnvelope>

    const isNew = await paymentsService.recordWebhook({
      provider,
      providerEventId: body.id,
      eventType: body.type,
      payload: body.data,
      signatureVerified: true,
    })

    if (!isNew) {
      // Already seen. 200, because a provider that gets anything else will
      // simply send it again, forever.
      log.debug({ provider, eventId: body.id }, 'duplicate webhook ignored')
      return ok(res, { received: true, duplicate: true })
    }

    // Stored, verified, and deduplicated. Acting on it belongs to a job, not to
    // this request: a gateway waiting on a socket while stock is committed is
    // how a timeout becomes a lost payment. v1 ships the manual provider, so
    // there is nothing to dispatch yet — the row is the record until there is.
    await paymentsService.markWebhookProcessed(provider, body.id)
    log.info({ provider, eventId: body.id, type: body.type }, 'webhook recorded')

    return ok(res, { received: true, duplicate: false })
  },
)
