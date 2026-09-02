/**
 * Payments, from the shop's side (§5.7).
 *
 * Two things live here that the per-order payment routes in `orders` cannot be:
 * a **ledger across every order**, which is what somebody reconciling a bank
 * statement reads, and the **review queue** for bank-transfer receipts, which is
 * a queue rather than a property of any one order.
 *
 * Deciding a proof is `payments:capture` — the same permission as marking an
 * order paid — because that is exactly what approving one does. Reading is
 * `payments:read`.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { ok, paginated } from '../../shared/http/respond.js'
import {
  buildPaginationMeta,
  offsetPaginationQuery,
  toOffset,
} from '../../shared/http/pagination.js'
import { idempotency } from '../../shared/middleware/idempotency.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { money } from '../catalogue/pricing.js'
import { mediaService } from '../media/index.js'
import { fulfillmentService } from '../orders/index.js'
import { proofsService } from './proofs.service.js'
import { proofDto } from './proofs.mapper.js'
import { paymentsService } from './payments.service.js'
import type { PaymentProof, PaymentProofStatus } from './proofs.types.js'

export const paymentsAdminRoutes: ExpressRouter = Router()

const idParam = z.strictObject({ id: z.uuid() })

const listPaymentsQuery = offsetPaginationQuery.extend({
  method: z.enum(['cod', 'bank_transfer', 'card', 'manual']).optional(),
  status: z
    .enum(['pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded'])
    .optional(),
})

const listProofsQuery = offsetPaginationQuery.extend({
  status: z.enum(['submitted', 'approved', 'rejected']).optional(),
})

const rejectSchema = z.strictObject({
  // Required, and shown to the customer. The database enforces it too.
  note: z.string().trim().min(1).max(1000),
})

/**
 * Resolves screenshot URLs for a page of proofs.
 *
 * One pass over the page rather than a request per row inside the mapper. The
 * queue is the hottest read in this feature and it is the one place where the
 * difference between 1 and 30 storage lookups is visible.
 */
async function withImages(proofs: PaymentProof[]) {
  const urls = await Promise.all(proofs.map((proof) => mediaService.urlForId(proof.mediaId)))
  return proofs.map((proof, index) => proofDto(proof, urls[index] ?? null))
}

// ── The ledger ───────────────────────────────────────────────────────────────

paymentsAdminRoutes.get(
  '/payments',
  requirePermission('payments:read'),
  validate({ query: listPaymentsQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof listPaymentsQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await paymentsService.list({
      ...(filter.method ? { method: filter.method } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      limit,
      offset,
    })

    return paginated(
      res,
      rows.map((payment) => ({
        id: payment.id,
        orderId: payment.orderId,
        orderNumber: payment.orderNumber,
        orderEmail: payment.orderEmail,
        method: payment.method,
        status: payment.status,
        amount: money(payment.amountCents, payment.currency),
        refunded: money(payment.refundedCents, payment.currency),
        provider: payment.provider,
        providerPaymentId: payment.providerPaymentId,
        failureMessage: payment.failureMessage,
        createdAt: payment.createdAt.toISOString(),
        capturedAt: payment.capturedAt?.toISOString() ?? null,
      })),
      buildPaginationMeta(filter, total),
    )
  },
)

// ── The review queue ─────────────────────────────────────────────────────────

paymentsAdminRoutes.get(
  '/payments/proofs',
  requirePermission('payments:read'),
  validate({ query: listProofsQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof listProofsQuery>>(req)
    const { limit, offset } = toOffset(filter)

    const { rows, total } = await proofsService.list({
      ...(filter.status ? { status: filter.status as PaymentProofStatus } : {}),
      limit,
      offset,
    })

    return paginated(res, await withImages(rows), buildPaginationMeta(filter, total), {
      // The badge on the navigation, and the thing that tells somebody whether
      // the queue is worth opening. Cheap enough to send on every page.
      pending: await proofsService.pendingCount(),
    })
  },
)

paymentsAdminRoutes.get(
  '/payments/proofs/:id',
  requirePermission('payments:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const proof = await proofsService.getById(req.params.id as string)
    const [dto] = await withImages([proof])
    return ok(res, dto)
  },
)

/**
 * The money arrived.
 *
 * Records a payment for the order's own outstanding balance and, when that
 * settles it, confirms the order — through `fulfillmentService.recordPayment`,
 * the same call behind the admin's "mark as paid". Nothing about the amount
 * comes from the proof.
 *
 * Idempotent, because this is a button next to a photograph and the natural
 * response to a slow response is to press it again.
 */
paymentsAdminRoutes.post(
  '/payments/proofs/:id/approve',
  requirePermission('payments:capture'),
  idempotency(),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const proof = await proofsService.approve(req.params.id as string, actor, (orderId) =>
      fulfillmentService.recordPayment(orderId, { method: 'bank_transfer' }, actor),
    )
    const [dto] = await withImages([proof])
    return ok(res, dto)
  },
)

paymentsAdminRoutes.post(
  '/payments/proofs/:id/reject',
  requirePermission('payments:capture'),
  validate({ params: idParam, body: rejectSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof rejectSchema>
    const proof = await proofsService.reject(req.params.id as string, body.note, actor)
    const [dto] = await withImages([proof])
    return ok(res, dto)
  },
)

// ── One order's proofs, for the order page ───────────────────────────────────

paymentsAdminRoutes.get(
  '/orders/:id/payment-proofs',
  requirePermission('payments:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const proofs = await proofsService.listForOrder(req.params.id as string)
    return ok(res, await withImages(proofs))
  },
)
