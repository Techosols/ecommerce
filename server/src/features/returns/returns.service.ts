/**
 * Returns — goods coming back (§5.6).
 *
 * ── The lifecycle, and why it is written down ───────────────────────────────
 *
 *   requested → approved → in_transit → received → closed
 *
 * with `declined` and `cancelled` as the two exits before the goods move. The
 * legal moves live in one table below rather than being checked at each call
 * site, because "received → approved" is not a mistake anybody should be able
 * to make by calling the wrong endpoint, and a machine that is enforced in five
 * places is enforced in four of them by next year.
 *
 * ── Units are committed when the return is opened ───────────────────────────
 *
 * Opening a return increments `order_items.returned_quantity`, so a second
 * return cannot be opened for units the first one already claims. Declining or
 * cancelling gives them back. The increment is conditional in SQL, so two
 * returns opened at the same instant cannot between them claim more units than
 * were bought.
 *
 * ── Receiving is the only event that increases stock ────────────────────────
 *
 * And it says what it is putting back: a quantity *and* a condition per line.
 * Only `resellable` units re-enter sellable stock; damaged, opened and
 * missing-parts units are recorded and written off. A return that silently
 * restocked everything would put broken goods back on sale, which is the one
 * failure here that reaches a second customer.
 *
 * ── Refunds stay separate ───────────────────────────────────────────────────
 *
 * Closing a return with a refund calls the ordinary refund path, with
 * `restock: false`: the goods came back at *receipt*, and restocking again
 * would double the stock. Money and goods are two events and this is where
 * that distinction earns its keep.
 */
import { v7 as uuidv7 } from 'uuid'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { inventoryService } from '../inventory/index.js'
import { fulfillmentService, ordersService } from '../orders/index.js'
import { returnsRepository as repo } from './returns.repository.js'
import type {
  ReturnCondition,
  ReturnDetail,
  ReturnListFilter,
  ReturnReason,
  ReturnRequest,
  ReturnStatus,
} from './returns.types.js'

const log = createLogger('returns')

/**
 * Legal moves. A transition that is not here cannot happen.
 *
 * `closed`, `declined` and `cancelled` are terminal and have no entry, which is
 * what stops a closed return being reopened and quietly refunded twice.
 */
const TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  requested: ['approved', 'declined', 'cancelled'],
  approved: ['in_transit', 'received', 'cancelled'],
  in_transit: ['received', 'cancelled'],
  received: ['closed'],
  declined: [],
  closed: [],
  cancelled: [],
}

/** The moves that stamp a date, and which one. */
const STAMPS: Partial<Record<ReturnStatus, 'approved_at' | 'received_at' | 'closed_at'>> = {
  approved: 'approved_at',
  received: 'received_at',
  closed: 'closed_at',
  declined: 'closed_at',
  cancelled: 'closed_at',
}

/** Only these units go back on the shelf. */
function restocks(condition: ReturnCondition): boolean {
  return condition === 'resellable'
}

export const returnsService = {
  // ── Reading ───────────────────────────────────────────────────────────────

  async detail(returnId: string): Promise<ReturnDetail> {
    const request = await repo.findById(returnId)
    if (!request) throw new NotFoundError('Return not found')

    const [lines, order] = await Promise.all([
      repo.lines(returnId),
      ordersService.getRaw(request.orderId),
    ])

    return {
      ...request,
      lines,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        email: order.email,
        currency: order.currency,
      },
    }
  },

  async list(filter: ReturnListFilter): Promise<{ rows: ReturnRequest[]; total: number }> {
    return repo.list(filter)
  },

  async forOrder(orderId: string): Promise<ReturnRequest[]> {
    return repo.forOrder(orderId)
  },

  /**
   * What can still be sent back on this order.
   *
   * Deliberately measured against what was *ordered* minus what is already
   * committed to a return, rather than against what a shipment record says went
   * out. Plenty of shops hand goods over without creating a shipment row — cash
   * on delivery, collection in person — and making returns depend on
   * bookkeeping they do not do would mean those orders could never be returned.
   *
   * The order-level rule does the work instead: nothing can come back from an
   * order that was cancelled or never confirmed, because nothing went out.
   */
  async returnable(orderId: string) {
    const order = await ordersService.getRaw(orderId)
    const items = await ordersService.items(orderId)

    const eligible =
      order.status === 'confirmed' || order.status === 'processing' || order.status === 'completed'

    return {
      orderId,
      currency: order.currency,
      eligible,
      reason: eligible
        ? null
        : order.status === 'cancelled'
          ? 'A cancelled order has nothing to return'
          : 'Nothing has gone out on this order yet',
      lines: items.map((item) => ({
        orderItemId: item.id,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        sku: item.sku,
        quantity: item.quantity,
        returnedQuantity: item.returnedQuantity,
        returnableQuantity: eligible ? Math.max(0, item.quantity - item.returnedQuantity) : 0,
      })),
    }
  },

  // ── Opening ───────────────────────────────────────────────────────────────

  /**
   * Opens a return and commits the units to it.
   *
   * `customerId` is the person the return belongs to, which is not necessarily
   * the actor: staff open returns on behalf of customers over the phone every
   * day. The audit entry records who actually did it.
   */
  async request(
    orderId: string,
    input: {
      reason: ReturnReason
      customerNote?: string | null
      lines: { orderItemId: string; quantity: number }[]
    },
    actor: Actor | null,
  ): Promise<ReturnDetail> {
    const order = await ordersService.getRaw(orderId)
    const summary = await this.returnable(orderId)
    if (!summary.eligible) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        summary.reason ?? 'Nothing on this order can be returned',
      )
    }

    if (input.lines.length === 0) {
      throw new ValidationError('A return needs at least one line')
    }
    const seen = new Set<string>()
    for (const line of input.lines) {
      if (seen.has(line.orderItemId)) {
        throw new ValidationError('That line appears twice; give it one quantity')
      }
      seen.add(line.orderItemId)
    }

    const returnId = uuidv7()

    await withTransaction(async () => {
      // The header first: the lines point at it, and inserting them ahead of it
      // is a foreign-key violation rather than a domain error.
      await repo.create({
        id: returnId,
        returnNumber: await repo.nextReturnNumber(),
        orderId,
        customerId: order.customerId,
        reason: input.reason,
        customerNote: input.customerNote ?? null,
      })

      for (const line of input.lines) {
        const known = summary.lines.find((entry) => entry.orderItemId === line.orderItemId)
        if (!known) {
          throw new DomainRuleError(
            ERROR_CODES.DOMAIN_RULE_VIOLATION,
            'That line does not belong to this order',
          )
        }

        // Conditional in SQL, so a concurrent return cannot slip past a check
        // done in JavaScript against a value read a moment ago.
        const committed = await repo.commitUnits(line.orderItemId, line.quantity)
        if (!committed) {
          throw new ConflictError(
            `Only ${known.returnableQuantity} of ${known.productTitle} can still be returned`,
            { code: ERROR_CODES.DOMAIN_RULE_VIOLATION },
          )
        }

        await repo.insertLine({
          id: uuidv7(),
          returnId,
          orderItemId: line.orderItemId,
          quantity: line.quantity,
        })
      }

      if (actor) {
        await auditService.record({
          actor,
          action: 'return.requested',
          resourceType: 'return',
          resourceId: returnId,
          after: { orderId, reason: input.reason, lines: input.lines.length },
        })
      }
    })

    log.info({ returnId, orderId }, 'return requested')
    return this.detail(returnId)
  },

  // ── Moving it along ───────────────────────────────────────────────────────

  /**
   * One named move.
   *
   * Legality is checked against the value read, and applied with a
   * compare-and-swap against that same value, so two staff clicking at once
   * produce one transition rather than two.
   */
  async transition(
    returnId: string,
    to: ReturnStatus,
    input: { staffNote?: string | null },
    actor: Actor,
  ): Promise<ReturnDetail> {
    const request = await repo.findById(returnId)
    if (!request) throw new NotFoundError('Return not found')

    if (!TRANSITIONS[request.status].includes(to)) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        `A ${request.status} return cannot become ${to}`,
      )
    }

    await withTransaction(async () => {
      const moved = await repo.transition({
        id: returnId,
        from: request.status,
        to,
        stamp: STAMPS[to] ?? null,
        staffNote: input.staffNote ?? null,
      })
      if (!moved) {
        throw new ConflictError('Somebody else moved this return; reload and try again', {
          code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
        })
      }

      // Declining or cancelling gives the units back, so the customer can open
      // a fresh return for them. Receiving does not — those units really have
      // come back and the line is settled.
      if (to === 'declined' || to === 'cancelled') {
        const lines = await repo.lines(returnId)
        for (const line of lines) {
          await repo.releaseUnits(line.orderItemId, line.quantity)
        }
      }

      await auditService.record({
        actor,
        action: `return.${to}`,
        resourceType: 'return',
        resourceId: returnId,
        before: { status: request.status },
        after: { status: to },
      })
    })

    log.info({ returnId, from: request.status, to }, 'return moved')
    return this.detail(returnId)
  },

  /**
   * Records what actually arrived, and puts back only what can be sold.
   *
   * Every line named must be one of this return's own, and the received
   * quantity cannot exceed what was requested — the database enforces the
   * second with a CHECK, and this reports it as a sentence rather than letting
   * a constraint violation surface as a 500.
   *
   * A line the operator does not mention is recorded as arriving at zero:
   * "nothing came back for this one" is an answer, and leaving it null would
   * mean a received return that nobody can say is complete.
   */
  async receive(
    returnId: string,
    input: {
      lines: { orderItemId: string; receivedQuantity: number; condition: ReturnCondition }[]
      staffNote?: string | null
    },
    actor: Actor,
  ): Promise<ReturnDetail> {
    const request = await repo.findById(returnId)
    if (!request) throw new NotFoundError('Return not found')

    if (!TRANSITIONS[request.status].includes('received')) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        `A ${request.status} return cannot be received`,
      )
    }

    const lines = await repo.lines(returnId)
    const orderItems = await ordersService.items(request.orderId)

    for (const entry of input.lines) {
      const line = lines.find((candidate) => candidate.orderItemId === entry.orderItemId)
      if (!line) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          'That line does not belong to this return',
        )
      }
      if (entry.receivedQuantity > line.quantity) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          `Only ${line.quantity} of that line were expected back`,
        )
      }
    }

    await withTransaction(async () => {
      const moved = await repo.transition({
        id: returnId,
        from: request.status,
        to: 'received',
        stamp: 'received_at',
        staffNote: input.staffNote ?? null,
      })
      if (!moved) {
        throw new ConflictError('Somebody else moved this return; reload and try again', {
          code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
        })
      }

      for (const line of lines) {
        const entry = input.lines.find((candidate) => candidate.orderItemId === line.orderItemId)
        const received = entry?.receivedQuantity ?? 0
        // An unmentioned line arrived as nothing, and `missing_parts` is the
        // honest label for that rather than leaving the condition unset.
        const condition: ReturnCondition = entry?.condition ?? 'missing_parts'
        const restocked = restocks(condition) ? received : 0

        await repo.recordReceipt({
          lineId: line.id,
          receivedQuantity: received,
          restockedQuantity: restocked,
          condition,
        })

        if (restocked === 0) continue

        const orderItem = orderItems.find((item) => item.id === line.orderItemId)
        if (!orderItem?.variantId) continue

        // The one event in this system that legitimately increases on-hand
        // stock, and it is an explicit movement with a reason rather than a
        // silent bump — so the ledger can later say where the units came from.
        await inventoryService.adjust(
          {
            variantId: orderItem.variantId,
            delta: restocked,
            reason: 'return',
            referenceType: 'return',
            referenceId: returnId,
            note: `Received back on ${request.returnNumber}`,
          },
          actor,
        )
      }

      await auditService.record({
        actor,
        action: 'return.received',
        resourceType: 'return',
        resourceId: returnId,
        after: { lines: input.lines },
      })
    })

    log.info({ returnId }, 'return received')
    return this.detail(returnId)
  },

  /**
   * Refunds what came back and closes the return.
   *
   * `restock: false` is load-bearing. The goods went back on the shelf at
   * receipt, and only the resellable ones did; letting the refund restock as
   * well would put the damaged units back too, and double the resellable ones.
   *
   * The units are still passed to the refund so that
   * `order_items.refunded_quantity` is recorded — that counter is what stops
   * the same units being refunded twice through the order page.
   */
  async refund(
    returnId: string,
    input: {
      paymentId: string
      amountCents: number
      reason?: string | null
      staffNote?: string | null
    },
    actor: Actor,
  ): Promise<ReturnDetail> {
    const request = await repo.findById(returnId)
    if (!request) throw new NotFoundError('Return not found')

    if (request.status !== 'received') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'Only a received return can be refunded — record what arrived first',
      )
    }
    if (request.refundId) {
      throw new ConflictError('This return has already been refunded', {
        code: ERROR_CODES.ALREADY_EXISTS,
      })
    }

    const lines = await repo.lines(returnId)
    const items = lines
      .filter((line) => line.receivedQuantity > 0)
      .map((line) => ({ orderItemId: line.orderItemId, quantity: line.receivedQuantity }))

    if (items.length === 0) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'Nothing arrived on this return, so there is nothing to refund',
      )
    }

    const refund = await fulfillmentService.refund(
      request.orderId,
      {
        paymentId: input.paymentId,
        amountCents: input.amountCents,
        reason: input.reason ?? `Return ${request.returnNumber}`,
        // The goods are already back. See the note above.
        restock: false,
        items,
      },
      actor,
    )

    await withTransaction(async () => {
      await repo.setRefund(returnId, refund.id)
      const moved = await repo.transition({
        id: returnId,
        from: 'received',
        to: 'closed',
        stamp: 'closed_at',
        staffNote: input.staffNote ?? null,
      })
      if (!moved) {
        throw new ConflictError('Somebody else closed this return', {
          code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
        })
      }

      await auditService.record({
        actor,
        action: 'return.refunded',
        resourceType: 'return',
        resourceId: returnId,
        after: { refundId: refund.id, amountCents: input.amountCents },
      })
    })

    log.info({ returnId, refundId: refund.id }, 'return refunded and closed')
    return this.detail(returnId)
  },
}
