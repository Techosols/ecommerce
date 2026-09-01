/**
 * Order administration (§7.1, §6.6).
 *
 * The routes are operations, not table rows. There is no `PATCH /orders/:id`
 * that would let someone set `total_cents`, or `status`, or a line price:
 * an order's money is fixed at checkout, and its statuses move through named
 * transitions that record who moved them and why.
 *
 * Five permissions, because five genuinely different decisions:
 *
 *   `orders:read`      see orders and their history
 *   `orders:write`     move an order along, annotate it, ship it
 *   `orders:cancel`    cancel an order (staff hold this; it returns stock)
 *   `payments:capture` record money received
 *   `payments:refund`  send money back
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import type { z } from 'zod'
import { accepted, created, noContent, ok, paginated } from '../../shared/http/respond.js'
import { buildPaginationMeta, toOffset } from '../../shared/http/pagination.js'
import { validate, validatedQuery } from '../../shared/middleware/validate.js'
import { requirePermission } from '../../shared/middleware/authorize.js'
import { requireActor } from '../../shared/middleware/authenticate.js'
import { idempotency } from '../../shared/middleware/idempotency.js'
import { IDEMPOTENCY_KEY_HEADER } from '../../config/index.js'
import { dateRangeQuery } from '../../shared/validation/common.js'
import { money } from '../catalogue/index.js'
import { settingsService } from '../settings/index.js'
import { checkoutAttemptsService } from './checkoutAttempts.service.js'
import { checkoutService } from './checkout.service.js'
import { draftsService, type DraftQuote } from './drafts.service.js'
import { fulfillmentService, outstandingFor } from './fulfillment.service.js'
import { ordersService } from './orders.service.js'
import {
  addressDto,
  adminOrderCardDto,
  adminOrderDto,
  orderNoteDto,
  statusHistoryDto,
  timelineEntryDto,
} from './orders.mapper.js'
import { ordersRepository } from './orders.repository.js'
import type { Order } from './orders.types.js'
import {
  createDraftSchema,
  draftListQuery,
  setDraftLinesSchema,
  updateDraftSchema,
  variantSearchQuery,
  checkoutAttemptListQuery,
  adminNoteSchema,
  annotationsSchema,
  cancelOrderSchema,
  idParam,
  noteParam,
  orderListQuery,
  orderNoteSchema,
  transitionSchema,
} from './orders.validators.js'
import {
  createShipmentSchema,
  recordPaymentSchema,
  refundSchema,
  shipmentIdParam,
  shipmentStatusSchema,
} from './fulfillment.validators.js'


/**
 * A draft in a list. Deliberately not `adminOrderCardDto`: a draft has no
 * placed date, no payment status worth showing and a placeholder number, and
 * rendering it through the order card would present all three as though they
 * meant something.
 */
function draftCardDto(draft: Order, currency: string) {
  return {
    id: draft.id,
    reference: draft.orderNumber,
    customerId: draft.customerId,
    email: draft.email || null,
    customerNote: draft.customerNote,
    subtotal: money(draft.subtotalCents, currency),
    draftedBy: draft.draftedBy,
    placedOrderId: draft.placedOrderId,
    placedFromDraftAt: draft.placedFromDraftAt?.toISOString() ?? null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  }
}

/**
 * Quotes a draft with the real pricer.
 *
 * This is the only place the two are joined: `draftsService` takes the pricer
 * as an argument so it never imports shipping, discounts or payments, and
 * `checkoutService.preview` is the same function the storefront quotes with —
 * so what a staff member reads down the phone is what checkout will charge.
 */
function quoteDraft(id: string) {
  return draftsService.quote(id, (args) =>
    checkoutService.preview({ ...args, customerFacing: false }),
  )
}

/**
 * A draft and what it currently costs.
 *
 * `blockers` are listed rather than thrown: a draft is expected to be
 * incomplete while somebody is building it, and refusing to answer until it is
 * finished would make the screen useless exactly while it is in use.
 */
async function draftQuoteDto(quote: DraftQuote) {
  const currency = quote.totals.currency
  const addresses = (await ordersRepository.addresses(quote.draft.id)).map(addressDto)

  return {
    ...draftCardDto(quote.draft, currency),
    phone: quote.draft.phone,
    paymentMethod: quote.draft.paymentMethod,
    shippingMethodId: quote.draft.shippingMethodId,
    discountCode: quote.draft.draftDiscountCode,
    addresses,
    lines: quote.lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      productTitle: line.productTitle,
      variantTitle: line.variantTitle,
      sku: line.sku,
      imageUrl: line.imageUrl,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      purchasable: line.purchasable,
      problem: line.problem,
    })),
    subtotal: money(quote.totals.subtotalCents, currency),
    discountTotal: money(quote.totals.discountCents, currency),
    shippingTotal: money(quote.totals.shippingCents, currency),
    taxTotal: money(quote.totals.taxCents, currency),
    paymentFee: money(quote.totals.paymentFeeCents, currency),
    total: money(quote.totals.totalCents, currency),
    shippingOptions: quote.shippingOptions.map((option) => ({
      methodId: option.methodId,
      name: option.name,
      description: option.description,
      amount: money(option.amountCents, currency),
      estimatedDaysMin: option.estimatedDaysMin,
      estimatedDaysMax: option.estimatedDaysMax,
    })),
    paymentMethods: quote.paymentMethods.map((method) => ({
      key: method.key,
      label: method.label,
      description: method.description,
      fee: money(method.feeCents, currency),
    })),
    purchasable: quote.purchasable,
    blockers: quote.blockers,
  }
}

export const ordersAdminRoutes: ExpressRouter = Router()

// ── Reading ─────────────────────────────────────────────────────────────────

ordersAdminRoutes.get(
  '/orders',
  requirePermission('orders:read'),
  validate({ query: orderListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof orderListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const { rows, total } = await ordersService.list({
      ...(filter.q ? { query: filter.q } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.paymentStatus ? { paymentStatus: filter.paymentStatus } : {}),
      ...(filter.fulfillmentStatus ? { fulfillmentStatus: filter.fulfillmentStatus } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.tags ? { tags: filter.tags } : {}),
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      limit,
      offset,
    })
    return paginated(res, rows.map(adminOrderCardDto), buildPaginationMeta(filter, total))
  },
)

ordersAdminRoutes.get(
  '/orders/:id',
  requirePermission('orders:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    return ok(res, adminOrderDto(await ordersService.detail(req.params.id as string)))
  },
)

/** Who moved this order, when, and why — the operational record. */
ordersAdminRoutes.get(
  '/orders/:id/history',
  requirePermission('orders:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const history = await ordersService.history(req.params.id as string)
    return ok(res, history.map(statusHistoryDto))
  },
)

/**
 * Everything that happened to this order, newest first.
 *
 * Assembled from the status history, the notes, the payments, the refunds and
 * the shipments — each of which already exists for its own reasons. There is no
 * events table behind this, deliberately: a stored feed is a second copy of the
 * truth, free to drift from the records it claims to describe.
 */
ordersAdminRoutes.get(
  '/orders/:id/timeline',
  requirePermission('orders:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const orderId = req.params.id as string
    const order = await ordersService.getRaw(orderId)
    const entries = await ordersService.timeline(orderId)
    return ok(res, entries.map((entry) => timelineEntryDto(entry, order.currency)))
  },
)

// ── Staff notes ─────────────────────────────────────────────────────────────

ordersAdminRoutes.get(
  '/orders/:id/notes',
  requirePermission('orders:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const notes = await ordersService.notes(req.params.id as string)
    return ok(res, notes.map(orderNoteDto))
  },
)

/** Appended, never edited: a note is a record of what somebody saw and when. */
ordersAdminRoutes.post(
  '/orders/:id/notes',
  requirePermission('orders:write'),
  validate({ params: idParam, body: orderNoteSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof orderNoteSchema>
    const note = await ordersService.addNote(req.params.id as string, body.body, actor)
    return created(res, orderNoteDto(note))
  },
)

ordersAdminRoutes.delete(
  '/orders/:id/notes/:noteId',
  requirePermission('orders:write'),
  validate({ params: noteParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await ordersService.deleteNote(req.params.id as string, req.params.noteId as string, actor)
    return noContent(res)
  },
)

// ── Moving an order along ───────────────────────────────────────────────────

/**
 * One named move on one status machine.
 *
 * The service checks the move is legal *and* applies it with a compare-and-swap
 * against the value it read, so two staff clicking at once produce one
 * transition and one history row.
 */
ordersAdminRoutes.post(
  '/orders/:id/transitions',
  requirePermission('orders:write'),
  validate({ params: idParam, body: transitionSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const orderId = req.params.id as string
    const body = req.body as z.infer<typeof transitionSchema>

    // Confirming is not merely a status move: it commits the reserved stock and
    // records the purchase against the customer's lifetime figures. Routing it
    // through `confirm()` is what stops a staff member confirming an order via
    // this endpoint and leaving its stock held but never taken.
    if (body.field === 'status' && body.to === 'confirmed') {
      return ok(res, adminOrderDto(await ordersService.confirm(orderId, actor, 'staff')))
    }
    // Likewise cancelling, which has to return the stock.
    if (body.field === 'status' && body.to === 'cancelled') {
      return ok(
        res,
        adminOrderDto(
          await ordersService.cancel(orderId, { reason: body.reason ?? null }, actor, 'staff'),
        ),
      )
    }

    await ordersService.transition(orderId, body.field, body.to, {
      actorUserId: actor.userId,
      actorType: 'staff',
      reason: body.reason ?? null,
      note: body.note ?? null,
    })
    return ok(res, adminOrderDto(await ordersService.detail(orderId)))
  },
)

/**
 * Accepts an order and commits its stock.
 *
 * The explicit name for what "confirm" means, and the action a shop takes on a
 * cash-on-delivery order: there is no payment to wait for, so accepting it *is*
 * the decision to ship. For a prepaid method this normally happens by itself
 * when the money lands.
 */
ordersAdminRoutes.post(
  '/orders/:id/confirm',
  requirePermission('orders:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    return ok(res, adminOrderDto(await ordersService.confirm(req.params.id as string, actor, 'staff')))
  },
)

ordersAdminRoutes.post(
  '/orders/:id/cancel',
  requirePermission('orders:cancel'),
  validate({ params: idParam, body: cancelOrderSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof cancelOrderSchema>
    const order = await ordersService.cancel(
      req.params.id as string,
      { reason: body.reason ?? null, ...(body.restock === undefined ? {} : { restock: body.restock }) },
      actor,
      'staff',
    )
    return ok(res, adminOrderDto(order))
  },
)

/** The internal note. Never returned on the storefront serialiser. */
ordersAdminRoutes.put(
  '/orders/:id/note',
  requirePermission('orders:write'),
  validate({ params: idParam, body: adminNoteSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof adminNoteSchema>
    return ok(res, adminOrderDto(await ordersService.setAdminNote(req.params.id as string, body.note, actor)))
  },
)

/**
 * The pinned note and the tags, in one edit.
 *
 * Both are staff annotation rather than order data — nothing downstream prices
 * or ships differently because of them — which is why they sit outside the
 * status machines and need only `orders:write`.
 */
ordersAdminRoutes.patch(
  '/orders/:id/annotations',
  requirePermission('orders:write'),
  validate({ params: idParam, body: annotationsSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof annotationsSchema>
    const order = await ordersService.setAnnotations(
      req.params.id as string,
      {
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
      },
      actor,
    )
    return ok(res, adminOrderDto(order))
  },
)

// ── Payments ────────────────────────────────────────────────────────────────

ordersAdminRoutes.get(
  '/orders/:id/payments',
  requirePermission('payments:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const orderId = req.params.id as string
    const order = await ordersService.getRaw(orderId)
    const [payments, refunds] = await Promise.all([
      fulfillmentService.payments(orderId),
      fulfillmentService.refunds(orderId),
    ])
    return ok(res, {
      payments: payments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        method: payment.method,
        status: payment.status,
        amount: money(payment.amountCents, payment.currency),
        refunded: money(payment.refundedCents, payment.currency),
        capturedAt: payment.capturedAt?.toISOString() ?? null,
        createdAt: payment.createdAt.toISOString(),
      })),
      refunds: refunds.map((refund) => ({
        id: refund.id,
        paymentId: refund.paymentId,
        amount: money(refund.amountCents, order.currency),
        reason: refund.reason,
        restock: refund.restock,
        createdAt: refund.createdAt.toISOString(),
      })),
      // What is still owed, computed from the payments rather than stored on
      // the order: a second copy of this number is a second copy to keep right.
      //
      // Measured against the total **net of refunds**, because the payment sum
      // is already net of them. Against the gross total a refund would re-open
      // a balance the customer does not owe.
      outstanding: money(
        await outstandingFor(orderId, order.totalCents - order.refundedTotalCents),
        order.currency,
      ),
    })
  },
)

/**
 * What is still refundable, and under which of the three limits.
 *
 * The dialog that follows is built entirely from this: the server decides the
 * maxima, and the browser never computes a refundable figure of its own.
 */
ordersAdminRoutes.get(
  '/orders/:id/refundable',
  requirePermission('payments:refund'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const summary = await fulfillmentService.refundable(req.params.id as string)
    return ok(res, {
      currency: summary.currency,
      maxRefundable: money(summary.maxRefundableCents, summary.currency),
      shippingTotal: money(summary.shippingTotalCents, summary.currency),
      payments: summary.payments.map((payment) => ({
        id: payment.id,
        method: payment.method,
        refundable: money(payment.refundable, summary.currency),
      })),
      lines: summary.lines.map((line) => ({
        orderItemId: line.orderItemId,
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        refundedQuantity: line.refundedQuantity,
        refundableQuantity: line.refundableQuantity,
        perUnit: money(line.perUnitCents, summary.currency),
        lineRefundable: money(line.lineRefundableCents, summary.currency),
      })),
    })
  },
)

/**
 * Records money received.
 *
 * The body never carries an amount by default — the payments service computes
 * the outstanding balance from the order itself. Idempotent by key, because a
 * retried "mark paid" must produce one payment, not two.
 */
ordersAdminRoutes.post(
  '/orders/:id/payments',
  requirePermission('payments:capture'),
  idempotency(),
  validate({ params: idParam, body: recordPaymentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof recordPaymentSchema>
    const payment = await fulfillmentService.recordPayment(
      req.params.id as string,
      {
        ...(body.method ? { method: body.method } : {}),
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.providerPaymentId ? { providerPaymentId: body.providerPaymentId } : {}),
        ...(body.amountCents === undefined ? {} : { amountCents: body.amountCents }),
        // Carried into the payments table, where a partial unique index makes
        // a duplicate capture impossible even if the middleware's record were
        // lost. Two independent defences, and this is what arms the second.
        idempotencyKey: req.get(IDEMPOTENCY_KEY_HEADER) ?? null,
      },
      actor,
    )
    return created(res, {
      id: payment.id,
      status: payment.status,
      amount: money(payment.amountCents, payment.currency),
      method: payment.method,
    })
  },
)

ordersAdminRoutes.post(
  '/orders/:id/refunds',
  requirePermission('payments:refund'),
  idempotency(),
  validate({ params: idParam, body: refundSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof refundSchema>
    const order = await ordersService.getRaw(req.params.id as string)
    const refund = await fulfillmentService.refund(
      req.params.id as string,
      {
        paymentId: body.paymentId,
        amountCents: body.amountCents,
        reason: body.reason ?? null,
        restock: body.restock ?? false,
        ...(body.items ? { items: body.items } : {}),
        // `refunds.idempotency_key` is UNIQUE: paying somebody twice is the one
        // mistake here that cannot be taken back, so it is guarded in the
        // schema as well as in the middleware.
        idempotencyKey: req.get(IDEMPOTENCY_KEY_HEADER) ?? null,
      },
      actor,
    )
    return created(res, {
      id: refund.id,
      amount: money(refund.amountCents, order.currency),
      reason: refund.reason,
      restock: refund.restock,
    })
  },
)

// ── Shipments ───────────────────────────────────────────────────────────────

ordersAdminRoutes.get(
  '/orders/:id/shipments',
  requirePermission('shipping:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    return ok(res, await fulfillmentService.listShipments(req.params.id as string))
  },
)

/**
 * Ships some or all of an order.
 *
 * Quantities are per line, and the conditional increment inside refuses to ship
 * more units than were ordered even if two staff create shipments at once. The
 * order's fulfilment status is then derived from what has actually gone.
 */
ordersAdminRoutes.post(
  '/orders/:id/shipments',
  requirePermission('shipping:write'),
  validate({ params: idParam, body: createShipmentSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createShipmentSchema>
    const shipment = await fulfillmentService.createShipment(
      req.params.id as string,
      {
        items: body.items,
        carrier: body.carrier ?? null,
        service: body.service ?? null,
        trackingNumber: body.trackingNumber ?? null,
        trackingUrl: body.trackingUrl ?? null,
      },
      actor,
    )
    return created(res, shipment)
  },
)

ordersAdminRoutes.post(
  '/shipments/:shipmentId/status',
  requirePermission('shipping:write'),
  validate({ params: shipmentIdParam, body: shipmentStatusSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof shipmentStatusSchema>
    const shipment = await fulfillmentService.setShipmentStatus(
      req.params.shipmentId as string,
      body.status,
      actor,
    )
    return accepted(res, shipment)
  },
)

// ── Checkout attempts ───────────────────────────────────────────────────────

/**
 * What happened at checkout, and what stopped it.
 *
 * Behind `orders:read`: an attempt is an order that did not happen, and the
 * people who work the order queue are the ones who need to know why.
 */
ordersAdminRoutes.get(
  '/checkout-attempts',
  requirePermission('orders:read'),
  validate({ query: checkoutAttemptListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof checkoutAttemptListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const [{ currency }, { rows, total }] = await Promise.all([
      settingsService.get(),
      checkoutAttemptsService.list({
        limit,
        offset,
        ...(filter.outcome ? { outcome: filter.outcome } : {}),
        ...(filter.failureCode ? { failureCode: filter.failureCode } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
      }),
    ])

    return paginated(
      res,
      rows.map((row) => ({
        id: row.id,
        cartId: row.cartId,
        customerId: row.customerId,
        email: row.email,
        orderId: row.orderId,
        outcome: row.outcome,
        failureCode: row.failureCode,
        failureMessage: row.failureMessage,
        subtotal: money(row.subtotalCents, currency),
        itemCount: row.itemCount,
        paymentMethod: row.paymentMethod,
        countryCode: row.countryCode,
        createdAt: row.createdAt.toISOString(),
      })),
      buildPaginationMeta(filter, total),
    )
  },
)

/**
 * The rate and the reasons, over a window.
 *
 * Separate from the list because "17% of checkouts failed" is a different
 * question from "show me the last twenty", and answering it by counting a page
 * would make the figure depend on the pager.
 */
ordersAdminRoutes.get(
  '/checkout-attempts/summary',
  requirePermission('orders:read'),
  validate({ query: dateRangeQuery }),
  async (req: Request, res: Response) => {
    const range = validatedQuery<{ from?: string; to?: string }>(req)
    // A default window rather than a required one: the question "how is
    // checkout doing" has an obvious answer for "lately", and making the
    // caller name a range to ask it is friction for nothing.
    const to = range.to ?? new Date().toISOString()
    const from = range.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString()
    return ok(res, { from, to, ...(await checkoutAttemptsService.summary({ from, to })) })
  },
)

// ── Draft orders ────────────────────────────────────────────────────────────

/**
 * Orders staff build by hand.
 *
 * `orders:write` throughout: a draft becomes a real sale, so building one is
 * the same authority as changing an order. Literal paths are declared before
 * `/orders/:id` in this file already, and these sit under `/drafts` so there is
 * no ambiguity at all.
 */
ordersAdminRoutes.get(
  '/drafts',
  requirePermission('orders:read'),
  validate({ query: draftListQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof draftListQuery>>(req)
    const { limit, offset } = toOffset(filter)
    const [{ currency }, { rows, total }] = await Promise.all([
      settingsService.get(),
      draftsService.list({ limit, offset, ...(filter.q ? { query: filter.q } : {}) }),
    ])

    return paginated(
      res,
      rows.map((draft) => draftCardDto(draft, currency)),
      buildPaginationMeta(filter, total),
    )
  },
)

/** Products a staff member can put on a draft. Declared before `/drafts/:id`. */
ordersAdminRoutes.get(
  '/drafts/variant-search',
  requirePermission('orders:read'),
  validate({ query: variantSearchQuery }),
  async (req: Request, res: Response) => {
    const filter = validatedQuery<z.infer<typeof variantSearchQuery>>(req)
    const [{ currency }, rows] = await Promise.all([
      settingsService.get(),
      draftsService.searchVariants(filter.q, filter.limit),
    ])

    return ok(
      res,
      rows.map((row) => ({
        variantId: row.variant_id,
        productId: row.product_id,
        productTitle: row.product_title,
        variantTitle: row.variant_title,
        sku: row.sku,
        price: money(row.price_amount, currency),
      })),
    )
  },
)

ordersAdminRoutes.post(
  '/drafts',
  requirePermission('orders:write'),
  validate({ body: createDraftSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const body = req.body as z.infer<typeof createDraftSchema>
    const draft = await draftsService.create(body, actor)
    const { currency } = await settingsService.get()
    return created(res, draftCardDto(draft, currency), `/api/v1/admin/drafts/${draft.id}`)
  },
)

ordersAdminRoutes.get(
  '/drafts/:id',
  requirePermission('orders:read'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    return ok(res, await draftQuoteDto(await quoteDraft(req.params.id as string)))
  },
)

ordersAdminRoutes.put(
  '/drafts/:id/lines',
  requirePermission('orders:write'),
  validate({ params: idParam, body: setDraftLinesSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const { lines } = req.body as z.infer<typeof setDraftLinesSchema>
    const draft = await draftsService.setLines(req.params.id as string, lines, actor)
    return ok(res, await draftQuoteDto(await quoteDraft(draft.id)))
  },
)

ordersAdminRoutes.patch(
  '/drafts/:id',
  requirePermission('orders:write'),
  validate({ params: idParam, body: updateDraftSchema }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const patch = req.body as z.infer<typeof updateDraftSchema>
    const draft = await draftsService.update(req.params.id as string, patch, actor)
    return ok(res, await draftQuoteDto(await quoteDraft(draft.id)))
  },
)

/**
 * Places it, through the ordinary checkout.
 *
 * Idempotent for the same reason storefront checkout is: a double-clicked
 * button must not reserve the stock twice.
 */
ordersAdminRoutes.post(
  '/drafts/:id/place',
  requirePermission('orders:write'),
  idempotency(),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    const order = await draftsService.place(req.params.id as string, actor, (input) => {
      const { customerId, ...checkout } = input
      return checkoutService.placeDraft(checkout, { customerId, actor })
    })
    return created(res, adminOrderDto(order), `/api/v1/admin/orders/${order.id}`)
  },
)

ordersAdminRoutes.delete(
  '/drafts/:id',
  requirePermission('orders:write'),
  validate({ params: idParam }),
  async (req: Request, res: Response) => {
    const actor = requireActor(req)
    await draftsService.discard(req.params.id as string, actor)
    return noContent(res)
  },
)
