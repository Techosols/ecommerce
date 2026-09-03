/**
 * Cash-on-delivery reconciliation (§7.1).
 *
 * ── Why these live in shipping but call orders ───────────────────────────────
 *
 * A remittance statement is a courier artefact — it arrives from shipping and
 * is matched by tracking number — but settling a line is a payment. The routes
 * follow the precedent `payments.admin.routes.ts` already set by calling
 * `fulfillmentService` across the feature boundary: the *service* layers stay
 * one-directional, the router is allowed to know about both.
 *
 * ── Why the file arrives as base64 in JSON ───────────────────────────────────
 *
 * The API accepts multipart nowhere. Media uses a presigned three-step upload
 * because the files are large and go to object storage; a courier statement is
 * a few kilobytes of CSV that is parsed and discarded, so adding multipart
 * handling and a second upload path for it would be more machinery than the
 * problem has. The 256kb JSON body limit is the ceiling, and it is a generous
 * one for a list of parcels.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 *
 * There is no "settle all". Every settlement confirms an order and commits its
 * stock, and a single button doing that for a whole spreadsheet is exactly the
 * destructive bulk action the admin is not allowed to offer. The client loops;
 * the server checks each one.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { created, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, offsetPaginationQuery, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { PayloadTooLargeError, ValidationError } from '../../shared/errors/index.js'
import { money } from '../catalogue/index.js'
import { fulfillmentService } from '../orders/index.js'
import { carrierService } from './carrier.service.js'
import { codService } from './cod.service.js'

export const codAdminRoutes: ExpressRouter = Router()

/** Statements are small; this is a sanity bound, not a business rule. */
const MAX_STATEMENT_BYTES = 2 * 1024 * 1024

const idParam = z.strictObject({ id: z.uuid() })

const importSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  /** The statement itself, base64-encoded. */
  content: z.string().min(1).max(3_000_000),
  reference: z.string().min(1).max(200).nullish(),
  /** The date on the statement, not today. */
  statementDate: z.iso.date().nullish(),
  /**
   * What the courier says it is paying over, if the covering note says.
   *
   * Optional and *not* used for matching: it is recorded so that "the courier
   * said 412,000 and the lines add up to 398,500" is a question somebody can
   * ask later.
   */
  declaredNetCents: z.number().int().nonnegative().nullish(),
  currency: z.string().length(3).nullish(),
})

/**
 * What the shop can do with its courier, for the admin to render from.
 *
 * Read rather than write permission: this decides which buttons exist, and a
 * member of staff who can see shipments needs to know whether booking one is
 * even possible.
 */
codAdminRoutes.get(
  '/shipping/carrier',
  requirePermission('shipping:read'),
  async (_req: Request, res: Response) => {
    return ok(res, { ...carrierService.capabilities(), canImportRemittances: codService.canImport() })
  },
)

/** The scan trail for one parcel. */
codAdminRoutes.get(
  '/shipping/shipments/:id/tracking',
  requirePermission('shipping:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    return ok(res, await carrierService.eventsFor(req.params.id as string))
  },
)

codAdminRoutes.get(
  '/shipping/cod/remittances',
  requirePermission('payments:read'),
  validate({ query: offsetPaginationQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof offsetPaginationQuery>>(req)
    const { items, total } = await codService.list(toOffset(filter))
    return paginated(res, items, buildPaginationMeta(filter, total))
  },
)

codAdminRoutes.get(
  '/shipping/cod/remittances/:id',
  requirePermission('payments:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const id = req.params.id as string
    const [remittance, lines] = await Promise.all([codService.get(id), codService.lines(id)])
    return ok(res, { ...remittance, lines })
  },
)

codAdminRoutes.post(
  '/shipping/cod/remittances',
  // Capture rather than a shipping permission: a statement is financial
  // evidence, and the only thing anyone does with one is bank money off it.
  requirePermission('payments:capture'),
  validate({ body: importSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof importSchema>

    const file = Buffer.from(body.content, 'base64')
    // `Buffer.from` never throws on bad base64 — it silently drops what it
    // cannot decode — so an empty result is the only signal that the client
    // sent something that was not base64 at all.
    if (file.length === 0) throw new ValidationError('That statement file is empty or not base64')
    if (file.length > MAX_STATEMENT_BYTES) {
      throw new PayloadTooLargeError('That statement is larger than 2MB')
    }

    const remittance = await fulfillmentService.importCodRemittance(
      {
        file,
        filename: body.filename,
        reference: body.reference ?? null,
        statementDate: body.statementDate ? new Date(body.statementDate) : null,
        declaredNetCents: body.declaredNetCents ?? null,
        currency: body.currency ?? null,
      },
      actor,
    )

    return created(res, remittance, `/api/v1/admin/shipping/cod/remittances/${remittance.id}`)
  },
)

/** Banks one matched line against its order. One line, one decision. */
codAdminRoutes.post(
  '/shipping/cod/lines/:id/settle',
  requirePermission('payments:capture'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const payment = await fulfillmentService.settleCodLine(req.params.id as string, actor)
    // The same payment shape the order's own payments list uses, so the admin
    // has one way to read a payment rather than two.
    return ok(res, {
      id: payment.id,
      provider: payment.provider,
      method: payment.method,
      status: payment.status,
      amount: money(payment.amountCents, payment.currency),
      capturedAt: payment.capturedAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
    })
  },
)
