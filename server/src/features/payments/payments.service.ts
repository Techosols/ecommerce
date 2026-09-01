/**
 * Payments and refunds (§5.7, CLAUDE.md §20).
 *
 * v1 ships a `manual` provider: cash on delivery and bank transfer, marked paid
 * by staff. The shape is a real gateway's from the start — authorize/capture,
 * provider ids, idempotency keys, a webhook table — because retrofitting those
 * onto a live payments table is not something anyone should have to do.
 *
 * Two rules:
 *
 *   **The amount comes from the order, never from the request.** A payment for
 *   an arbitrary amount is a self-service discount.
 *
 *   **Every settlement is idempotent.** A retried "mark paid" and a redelivered
 *   webhook must produce one payment, not two.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { registerConstraintError } from '../../infrastructure/database/errors.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'

const log = createLogger('payments')

registerConstraintError(
  'payments_idempotency_idx',
  ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
  'A payment with that idempotency key already exists',
)
registerConstraintError(
  'one_row_per_provider_event',
  ERROR_CODES.ALREADY_EXISTS,
  'That provider event has already been received',
)

export type PaymentMethod = 'manual' | 'cod' | 'bank_transfer' | 'card'
export type PaymentState =
  | 'pending' | 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded'

export interface Payment {
  id: string
  orderId: string
  provider: string
  providerPaymentId: string | null
  method: PaymentMethod
  status: PaymentState
  amountCents: number
  currency: string
  refundedCents: number
  failureCode: string | null
  failureMessage: string | null
  authorizedAt: Date | null
  capturedAt: Date | null
  failedAt: Date | null
  createdAt: Date
}

export interface Refund {
  id: string
  paymentId: string
  orderId: string
  amountCents: number
  reason: string | null
  status: 'pending' | 'succeeded' | 'failed'
  restock: boolean
  createdAt: Date
}

interface PaymentRow {
  id: string
  order_id: string
  provider: string
  provider_payment_id: string | null
  method: PaymentMethod
  status: PaymentState
  amount_cents: number
  currency: string
  refunded_cents: number
  failure_code: string | null
  failure_message: string | null
  authorized_at: Date | null
  captured_at: Date | null
  failed_at: Date | null
  created_at: Date
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    method: row.method,
    status: row.status,
    amountCents: row.amount_cents,
    currency: row.currency,
    refundedCents: row.refunded_cents,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    authorizedAt: row.authorized_at,
    capturedAt: row.captured_at,
    failedAt: row.failed_at,
    createdAt: row.created_at,
  }
}

export const paymentsService = {
  async listForOrder(orderId: string): Promise<Payment[]> {
    const rows = await query<PaymentRow>(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
      { name: 'payments.listForOrder' },
    )
    return rows.map(toPayment)
  },

  async getById(id: string): Promise<Payment> {
    const row = await queryOne<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [id], {
      name: 'payments.getById',
    })
    if (!row) throw new NotFoundError('Payment not found')
    return toPayment(row)
  },

  /**
   * Records a payment against an order.
   *
   * The amount is the order's outstanding balance, computed here — the caller
   * says *which* order and *how* it was paid, never *how much*.
   */
  async record(
    input: {
      orderId: string
      method: PaymentMethod
      provider?: string
      providerPaymentId?: string | null
      idempotencyKey?: string | null
      amountCents?: number
      metadata?: Record<string, unknown>
    },
    context: {
      order: {
        totalCents: number
        refundedTotalCents: number
        currency: string
        orderNumber: string
        email: string
      }
      actor: Actor | null
      onPaid: (paymentId: string) => Promise<void>
    },
  ): Promise<Payment> {
    const outstanding = await this.outstandingFor(
      input.orderId,
      context.order.totalCents - context.order.refundedTotalCents,
    )
    const amount = input.amountCents ?? outstanding

    if (amount <= 0) {
      throw new DomainRuleError(
        ERROR_CODES.PAYMENT_ALREADY_SETTLED,
        'This order has already been paid in full',
      )
    }
    if (amount > outstanding) {
      throw new ValidationError(
        `That is more than the outstanding balance of ${outstanding}`,
      )
    }

    const paymentId = uuidv7()
    await withTransaction(async () => {
      await execute(
        `INSERT INTO payments
           (id, order_id, provider, provider_payment_id, method, status, amount_cents,
            currency, idempotency_key, metadata, captured_at)
         VALUES ($1,$2,$3,$4,$5,'paid',$6,$7,$8,$9, now())`,
        [
          paymentId, input.orderId, input.provider ?? 'manual', input.providerPaymentId ?? null,
          input.method, amount, context.order.currency, input.idempotencyKey ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
        { name: 'payments.record' },
      )

      if (context.actor) {
        await auditService.record({
          actor: context.actor,
          action: 'payment.recorded',
          resourceType: 'order',
          resourceId: input.orderId,
          after: { paymentId, amountCents: amount, method: input.method },
        })
      }

      await publish(
        'payment.created',
        { paymentId, orderId: input.orderId, amountCents: amount, method: input.method },
        { aggregateId: input.orderId, actorUserId: context.actor?.userId ?? undefined },
      )
      await publish(
        'payment.succeeded',
        {
          paymentId,
          orderId: input.orderId,
          orderNumber: context.order.orderNumber,
          email: context.order.email,
          amountCents: amount,
        },
        { aggregateId: input.orderId, actorUserId: context.actor?.userId ?? undefined },
      )
    })

    // Confirming the order — and committing its stock — happens once the money
    // is recorded, not before.
    if (amount >= outstanding) await context.onPaid(paymentId)

    log.info({ paymentId, orderId: input.orderId, amountCents: amount }, 'payment recorded')
    return this.getById(paymentId)
  },

  /**
   * What the customer still owes.
   *
   * `netDueCents` is the order total **less what has been refunded**, and that
   * is the whole subtlety here. The sum below already nets refunds off the
   * money the shop is holding, so measuring it against the gross total counts
   * every refund twice: refund half a paid order and the balance re-opens for
   * the amount just sent back, telling staff to chase a customer who owes
   * nothing — and letting them record a second payment against a settled order.
   *
   * Both sides have to be net, or neither.
   */
  async outstandingFor(orderId: string, netDueCents: number): Promise<number> {
    const row = await queryOne<{ paid: string }>(
      `SELECT coalesce(sum(amount_cents - refunded_cents), 0) AS paid
         FROM payments WHERE order_id = $1 AND status IN ('paid','partially_refunded')`,
      [orderId],
      { name: 'payments.outstandingFor' },
    )
    return Math.max(netDueCents - Number(row?.paid ?? 0), 0)
  },

  async markFailed(paymentId: string, code: string | null, message: string | null): Promise<void> {
    await execute(
      `UPDATE payments SET status = 'failed', failure_code = $2, failure_message = $3,
              failed_at = now()
        WHERE id = $1 AND status IN ('pending','authorized')`,
      [paymentId, code, message],
      { name: 'payments.markFailed' },
    )
    const payment = await this.getById(paymentId)
    await publish(
      'payment.failed',
      { paymentId, orderId: payment.orderId, reason: message },
      { aggregateId: payment.orderId },
    )
  },

  // ── Refunds ───────────────────────────────────────────────────────────────

  /**
   * Refunds part or all of a payment.
   *
   * The conditional `UPDATE` is what makes it safe: two staff refunding at once
   * cannot together exceed the payment, because the second one's predicate
   * fails against the first's committed row.
   */
  async refund(
    input: {
      paymentId: string
      amountCents: number
      reason?: string | null
      restock?: boolean
      idempotencyKey?: string | null
    },
    context: {
      actor: Actor
      order: { orderNumber: string; email: string }
      onRefunded: (refund: Refund) => Promise<void>
    },
  ): Promise<Refund> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ValidationError('A refund must be a whole, positive amount')
    }

    const payment = await this.getById(input.paymentId)
    if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'Only a captured payment can be refunded',
      )
    }

    const refundId = uuidv7()
    await withTransaction(async () => {
      const applied = await execute(
        `UPDATE payments
            SET refunded_cents = refunded_cents + $2,
                status = CASE WHEN refunded_cents + $2 >= amount_cents
                              THEN 'refunded' ELSE 'partially_refunded' END
          WHERE id = $1 AND refunded_cents + $2 <= amount_cents`,
        [input.paymentId, input.amountCents],
        { name: 'payments.applyRefund' },
      )
      if (applied !== 1) {
        throw new ConflictError('That is more than remains on this payment', {
          code: ERROR_CODES.REFUND_EXCEEDS_PAYMENT,
        })
      }

      await execute(
        `INSERT INTO refunds
           (id, payment_id, order_id, amount_cents, reason, status, restock, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7,$8)`,
        [
          refundId, input.paymentId, payment.orderId, input.amountCents,
          input.reason ?? null, input.restock ?? false, context.actor.userId,
          input.idempotencyKey ?? null,
        ],
        { name: 'payments.createRefund' },
      )

      await auditService.record({
        actor: context.actor,
        action: 'payment.refunded',
        resourceType: 'order',
        resourceId: payment.orderId,
        after: { refundId, amountCents: input.amountCents, reason: input.reason ?? null },
      })
      await publish(
        'payment.refunded',
        {
          refundId,
          paymentId: input.paymentId,
          orderId: payment.orderId,
          orderNumber: context.order.orderNumber,
          email: context.order.email,
          amountCents: input.amountCents,
          restock: input.restock ?? false,
        },
        { aggregateId: payment.orderId, actorUserId: context.actor.userId },
      )
    })

    const refund = await this.getRefund(refundId)
    await context.onRefunded(refund)

    log.info({ refundId, paymentId: input.paymentId, amountCents: input.amountCents }, 'refund issued')
    return refund
  },

  async getRefund(id: string): Promise<Refund> {
    const row = await queryOne<{
      id: string
      payment_id: string
      order_id: string
      amount_cents: number
      reason: string | null
      status: 'pending' | 'succeeded' | 'failed'
      restock: boolean
      created_at: Date
    }>(`SELECT * FROM refunds WHERE id = $1`, [id], { name: 'payments.getRefund' })
    if (!row) throw new NotFoundError('Refund not found')
    return {
      id: row.id,
      paymentId: row.payment_id,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      reason: row.reason,
      status: row.status,
      restock: row.restock,
      createdAt: row.created_at,
    }
  },

  async listRefundsForOrder(orderId: string): Promise<Refund[]> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM refunds WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
      { name: 'payments.listRefunds' },
    )
    return Promise.all(rows.map((row) => this.getRefund(row.id)))
  },

  // ── Provider webhooks ─────────────────────────────────────────────────────

  /**
   * Stores an inbound provider callback, exactly once.
   *
   * The unique constraint on `(provider, provider_event_id)` is the entire
   * duplicate defence: a second delivery fails the insert and the caller
   * answers 200 without reprocessing. Returns false when the event was already
   * seen.
   */
  async recordWebhook(input: {
    provider: string
    providerEventId: string
    eventType: string
    payload: Record<string, unknown>
    signatureVerified: boolean
  }): Promise<boolean> {
    const inserted = await execute(
      `INSERT INTO webhook_events
         (provider, provider_event_id, event_type, payload, signature_verified)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [
        input.provider, input.providerEventId, input.eventType,
        JSON.stringify(input.payload), input.signatureVerified,
      ],
      { name: 'payments.recordWebhook' },
    )
    return inserted === 1
  },

  async markWebhookProcessed(provider: string, providerEventId: string, error?: string): Promise<void> {
    await execute(
      `UPDATE webhook_events
          SET processed_at = CASE WHEN $3::text IS NULL THEN now() ELSE processed_at END,
              attempts = attempts + 1,
              last_error = $3
        WHERE provider = $1 AND provider_event_id = $2`,
      [provider, providerEventId, error ?? null],
      { name: 'payments.markWebhookProcessed' },
    )
  },
}
