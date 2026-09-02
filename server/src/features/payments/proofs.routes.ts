/**
 * Paying by bank transfer, from the customer's side (§5.7).
 *
 * ── How these routes are protected ───────────────────────────────────────────
 *
 * Not by a session. Bank transfer is used mostly by guests, and a customer who
 * has just been told to go and make a transfer will come back through the
 * confirmation page or an order-lookup link, often on a different device from
 * the one they checked out on. Demanding an account here would mean demanding
 * registration in order to pay.
 *
 * So every route below is scoped exactly the way the guest order lookup already
 * is — the **order number and the email it was placed with**, both required,
 * with the same rate limit and the same indistinguishable 404 on either half
 * being wrong. That pair is already the credential this shop trusts to show
 * somebody their own order; it is not a weaker one invented for payments.
 *
 * What that pair can do here is deliberately small: read where to send money,
 * get a URL to upload one image to, and attach that image to their own order as
 * a claim. It cannot read anybody else's order, cannot change an amount, and
 * cannot mark anything paid. Approving is `payments:capture`, in the admin.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { accepted, created, ok } from '../../shared/http/respond.js'
import { authenticateOptional } from '../../shared/middleware/authenticate.js'
import { ipLimiter } from '../../shared/middleware/rateLimit.js'
import { validate } from '../../shared/middleware/validate.js'
import { NotFoundError } from '../../shared/errors/index.js'
import { env } from '../../config/index.js'
import { ALLOWED_IMAGE_TYPES } from '../../infrastructure/storage/index.js'
import { mediaService } from '../media/index.js'
import { ordersService } from '../orders/index.js'
import { settingsService } from '../settings/index.js'
import { proofsService } from './proofs.service.js'
import { proofDto, publicProofDto } from './proofs.mapper.js'

export const proofsStorefrontRoutes: ExpressRouter = Router()

/**
 * The pair that stands in for a session.
 *
 * Order number and email, on every request. Kept as one schema so no route can
 * accidentally ask for less.
 */
const orderClaim = {
  orderNumber: z.string().trim().min(1).max(32),
  email: z.email().max(320),
}

const lookupSchema = z.strictObject(orderClaim)

const requestUploadSchema = z.strictObject({
  ...orderClaim,
  contentType: z.enum(Object.keys(ALLOWED_IMAGE_TYPES) as [string, ...string[]]),
  byteSize: z.number().int().positive().max(env.MEDIA_MAX_BYTES),
  filename: z.string().max(255).optional(),
})

const completeUploadSchema = z.strictObject({
  ...orderClaim,
  assetId: z.uuid(),
})

const submitProofSchema = z.strictObject({
  ...orderClaim,
  mediaId: z.uuid(),
  senderName: z.string().trim().min(1).max(120),
  senderBank: z.string().trim().min(1).max(120),
  // Four digits or nothing. Anything longer is refused rather than truncated:
  // silently storing part of what somebody typed is worse than asking again.
  accountLast4: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, 'Enter the last four digits')
    .optional(),
})

/**
 * Ten attempts per quarter hour, per IP.
 *
 * The same shape as the order-lookup limiter, because it is protecting the same
 * thing: order numbers come from a sequence and are guessable, so the limit is
 * what makes walking them useless.
 */
const claimLimiter = ipLimiter({ windowMs: 15 * 60_000, limit: 10 })

/**
 * Resolves a request to an order the caller is entitled to pay for, or 404.
 *
 * Two ways in, and the order matters.
 *
 * A **signed-in customer** is matched on ownership: their own order, found by
 * number. This exists because `lookupGuestOrder` deliberately refuses any order
 * whose account has a password — that restriction is what stops somebody
 * walking guessable order numbers against a known email — and without this
 * branch a registered customer could not pay for their own order at all.
 *
 * Everybody else falls back to the **guest claim**: number and email, exactly
 * as the order-lookup page uses it, with the same restriction still in force.
 *
 * Either way the failure is identical and says nothing about which half was
 * wrong, so neither route can be used to discover which order numbers exist or
 * which addresses have shopped here.
 */
async function orderFromClaim(req: Request, orderNumber: string, email: string) {
  const actorId = req.actor?.userId ?? null

  if (actorId) {
    const own = await ordersService.findByNumberForCustomer(orderNumber.trim(), actorId)
    if (own) return own
  }

  const order = await ordersService.lookupGuestOrder(orderNumber, email).catch(() => undefined)
  if (!order) throw new NotFoundError('No order matches that number and email address')
  return order
}

/**
 * Where to send the money, and how the last attempt went.
 *
 * One request serves the whole payment page: the account details, whether a
 * receipt is already waiting for review, and — if one was rejected — what the
 * shop said about it, which is the thing the customer most needs to see.
 */
proofsStorefrontRoutes.post(
  '/payments/bank-transfer',
  authenticateOptional(),
  claimLimiter,
  validate({ body: lookupSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof lookupSchema>
    const order = await orderFromClaim(req, body.orderNumber, body.email)

    const settings = await settingsService.get()
    const proofs = await proofsService.listForOrder(order.id)

    return ok(res, {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        total: { amount: order.totalCents, currency: order.currency },
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        status: order.status,
      },
      // Null when the method is off, or when this order was not placed to be
      // paid this way — there is nothing to show either person.
      bankDetails:
        order.paymentMethod === 'bank_transfer' ? settingsService.bankDetails(settings) : null,
      proofs: proofs.map(publicProofDto),
    })
  },
)

/** Step 1 of the upload, for a customer rather than for staff. */
proofsStorefrontRoutes.post(
  '/payments/bank-transfer/uploads',
  authenticateOptional(),
  claimLimiter,
  validate({ body: requestUploadSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof requestUploadSchema>
    // Proves they hold the order before a storage key is ever generated.
    await orderFromClaim(req, body.orderNumber, body.email)

    const ticket = await mediaService.requestUpload({
      contentType: body.contentType,
      byteSize: body.byteSize,
      ...(body.filename ? { filename: body.filename } : {}),
      // Nobody is signed in. The asset is recorded with no uploader, which the
      // column has always allowed.
      actor: null,
    })

    return accepted(res, {
      assetId: ticket.assetId,
      upload: {
        url: ticket.uploadUrl,
        method: ticket.method,
        token: ticket.uploadToken,
        expiresAt: ticket.expiresAt.toISOString(),
      },
    })
  },
)

/** Step 3: the bytes have been PUT; inspect them and queue processing. */
proofsStorefrontRoutes.post(
  '/payments/bank-transfer/uploads/complete',
  authenticateOptional(),
  claimLimiter,
  validate({ body: completeUploadSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof completeUploadSchema>
    await orderFromClaim(req, body.orderNumber, body.email)

    const asset = await mediaService.completeUpload(body.assetId, null)
    return accepted(res, { id: asset.id, status: asset.status })
  },
)

/** "Here is the receipt." */
proofsStorefrontRoutes.post(
  '/payments/bank-transfer/proofs',
  authenticateOptional(),
  claimLimiter,
  validate({ body: submitProofSchema }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof submitProofSchema>
    const order = await orderFromClaim(req, body.orderNumber, body.email)

    const proof = await proofsService.submit(
      {
        orderId: order.id,
        mediaId: body.mediaId,
        senderName: body.senderName,
        senderBank: body.senderBank,
        ...(body.accountLast4 ? { accountLast4: body.accountLast4 } : {}),
        submittedBy: req.actor?.userId ?? null,
      },
      {
        id: order.id,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        status: order.status,
      },
    )

    return created(res, publicProofDto(proof))
  },
)

export { proofDto }
