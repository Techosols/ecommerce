/**
 * Payment proofs (§5.7).
 *
 * A customer's claim that they sent money, and what a member of staff decided
 * about it. Every field the customer supplied is unverified by construction —
 * nothing in the system reads these to compute a balance.
 */

export type PaymentProofStatus = 'submitted' | 'approved' | 'rejected'

export interface PaymentProof {
  id: string
  orderId: string
  status: PaymentProofStatus

  /** The screenshot. Rendered through the media service, never as a raw key. */
  mediaId: string

  // ── Claimed by the customer. Evidence for a human, not input to arithmetic.
  senderName: string
  senderBank: string
  accountLast4: string | null

  // ── The decision.
  reviewedAt: Date | null
  reviewedBy: string | null
  /** Snapshotted, so the record still reads correctly after the account goes. */
  reviewedByName: string | null
  reviewNote: string | null

  /** The payment this produced, once approved. */
  paymentId: string | null

  submittedBy: string | null
  submittedAt: Date

  /**
   * The order, when the proof was read through the review queue.
   *
   * Joined rather than fetched per row: a queue of thirty proofs must not be
   * thirty extra order reads, and a screenshot with no order beside it is not
   * something anybody can decide about.
   */
  order?: {
    orderNumber: string
    email: string
    totalCents: number
    currency: string
    status: string
  }
}
