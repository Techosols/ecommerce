/**
 * Payment domain types.
 */

export type PaymentStatus = 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled' | 'refunded'

export interface Payment {
  id: string
  idempotencyKey: string
  checkoutId: string
  amountMinor: number
  currency: string
  providerName: string
  providerPaymentId: string | null
  providerCustomerId: string | null
  status: PaymentStatus
  failureReason: string | null
  failureCode: string | null
  lastWebhookEvent: string | null
  lastWebhookReceivedAt: Date | null
  refundedAmountMinor: number
  refundReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PaymentWebhookLog {
  id: string
  paymentId: string
  providerName: string
  eventType: string
  providerEventId: string
  payload: object
  processed: boolean
  processedResult: string | null
  processingError: string | null
  receivedAt: Date
  processedAt: Date | null
}
