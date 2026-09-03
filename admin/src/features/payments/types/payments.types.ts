import type { Money } from '@/types/api'

export type PaymentMethod = 'cod' | 'bank_transfer' | 'card' | 'manual'

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'

/** A row in the ledger, as `GET /admin/payments` publishes it. */
export interface PaymentRow {
  id: string
  orderId: string
  orderNumber: string
  orderEmail: string
  method: PaymentMethod
  status: PaymentStatus
  amount: Money
  refunded: Money
  provider: string
  providerPaymentId: string | null
  failureMessage: string | null
  createdAt: string
  capturedAt: string | null
}

export type ProofStatus = 'submitted' | 'approved' | 'rejected'

/**
 * A customer's claim that they sent money, plus what was decided about it.
 *
 * Everything under `claim` was typed by an anonymous person into a public form.
 * It is here to be compared against a bank statement — the UI must never let it
 * look like a figure the system agreed with.
 */
export interface PaymentProof {
  id: string
  orderId: string
  status: ProofStatus

  claim: {
    senderName: string
    senderBank: string
    accountLast4: string | null
  }

  imageUrl: string | null
  mediaId: string

  submittedAt: string
  submittedBy: string | null

  reviewedAt: string | null
  reviewedBy: string | null
  reviewedByName: string | null
  reviewNote: string | null
  paymentId: string | null

  /** Present on the queue, absent when read through one order. */
  order?: {
    orderNumber: string
    email: string
    total: Money
    status: string
  }
}

export interface PaymentListParams {
  page?: number
  limit?: number
  method?: PaymentMethod
  status?: PaymentStatus
}

export interface ProofListParams {
  page?: number
  limit?: number
  status?: ProofStatus
}
