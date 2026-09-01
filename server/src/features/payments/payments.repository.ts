/**
 * Payment data access.
 */

import { queryOne } from '../../infrastructure/database/query.js'
import type { Payment, PaymentStatus } from './payments.types.js'

interface PaymentRow {
  id: string
  idempotency_key: string
  checkout_id: string
  amount_minor: number
  currency: string
  provider_name: string
  provider_payment_id: string | null
  provider_customer_id: string | null
  status: PaymentStatus
  failure_reason: string | null
  failure_code: string | null
  last_webhook_event: string | null
  last_webhook_received_at: string | null
  refunded_amount_minor: number
  refund_reason: string | null
  created_at: string
  updated_at: string
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    checkoutId: row.checkout_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    providerName: row.provider_name,
    providerPaymentId: row.provider_payment_id,
    providerCustomerId: row.provider_customer_id,
    status: row.status,
    failureReason: row.failure_reason,
    failureCode: row.failure_code,
    lastWebhookEvent: row.last_webhook_event,
    lastWebhookReceivedAt: row.last_webhook_received_at ? new Date(row.last_webhook_received_at) : null,
    refundedAmountMinor: row.refunded_amount_minor,
    refundReason: row.refund_reason,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

export const paymentsRepository = {
  async create(input: {
    idempotencyKey: string
    checkoutId: string
    amountMinor: number
    currency: string
    providerName: string
    providerPaymentId?: string | null
    providerCustomerId?: string | null
  }): Promise<Payment> {
    const row = await queryOne<PaymentRow>(
      `INSERT INTO payments (
        idempotency_key,
        checkout_id,
        amount_minor,
        currency,
        provider_name,
        provider_payment_id,
        provider_customer_id,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *`,
      [
        input.idempotencyKey,
        input.checkoutId,
        input.amountMinor,
        input.currency,
        input.providerName,
        input.providerPaymentId ?? null,
        input.providerCustomerId ?? null,
      ],
      { name: 'payments.create' },
    )

    if (!row) throw new Error('Failed to create payment')
    return toPayment(row)
  },

  async findById(id: string): Promise<Payment | undefined> {
    const row = await queryOne<PaymentRow>(`SELECT * FROM payments WHERE id = $1`, [id], {
      name: 'payments.findById',
    })
    return row ? toPayment(row) : undefined
  },

  async findByCheckoutId(checkoutId: string): Promise<Payment | undefined> {
    const row = await queryOne<PaymentRow>(
      `SELECT * FROM payments WHERE checkout_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [checkoutId],
      { name: 'payments.findByCheckoutId' },
    )
    return row ? toPayment(row) : undefined
  },

  async updateStatus(
    paymentId: string,
    status: PaymentStatus,
    patch: { failureReason?: string | null; failureCode?: string | null; providerPaymentId?: string | null; lastWebhookEvent?: string | null } = {},
  ): Promise<Payment | undefined> {
    const row = await queryOne<PaymentRow>(
      `UPDATE payments
       SET status = $2,
           failure_reason = COALESCE($3, failure_reason),
           failure_code = COALESCE($4, failure_code),
           provider_payment_id = COALESCE($5, provider_payment_id),
           last_webhook_event = COALESCE($6, last_webhook_event),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        paymentId,
        status,
        patch.failureReason ?? null,
        patch.failureCode ?? null,
        patch.providerPaymentId ?? null,
        patch.lastWebhookEvent ?? null,
      ],
      { name: 'payments.updateStatus' },
    )
    return row ? toPayment(row) : undefined
  },
}
