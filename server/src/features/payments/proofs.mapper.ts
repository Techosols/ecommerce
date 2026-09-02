/**
 * What a payment proof looks like on the wire (§23.14).
 *
 * Two shapes, built by hand rather than by omitting fields from one another.
 * The customer's view must never gain a field because somebody added a column;
 * it gains one when somebody writes it here on purpose.
 */
import { money } from '../catalogue/pricing.js'
import type { PaymentProof } from './proofs.types.js'

/**
 * The customer's view of their own submission.
 *
 * They see that it arrived, what became of it, and — if it was turned down —
 * why, because that is the only part they can act on. They do not see who
 * reviewed it: which member of staff looked at a receipt is the shop's business
 * and naming them invites the argument to become personal.
 */
export function publicProofDto(proof: PaymentProof) {
  return {
    id: proof.id,
    status: proof.status,
    submittedAt: proof.submittedAt.toISOString(),
    reviewedAt: proof.reviewedAt?.toISOString() ?? null,
    // Written for the customer; the database refuses a rejection without one.
    reviewNote: proof.status === 'rejected' ? proof.reviewNote : null,
    senderName: proof.senderName,
    senderBank: proof.senderBank,
  }
}

/**
 * The reviewer's view.
 *
 * Everything the customer claimed, the screenshot, and who decided what. The
 * image URL is resolved by the caller, which owns the media service — the
 * mapper stays synchronous and free of I/O so it can be used inside a loop over
 * a page of the queue without turning into a request per row.
 */
export function proofDto(proof: PaymentProof, imageUrl: string | null = null) {
  return {
    id: proof.id,
    orderId: proof.orderId,
    status: proof.status,

    // The claim. Everything in this block was typed by an anonymous person and
    // is here to be compared against a bank statement, never to be trusted.
    claim: {
      senderName: proof.senderName,
      senderBank: proof.senderBank,
      accountLast4: proof.accountLast4,
    },

    imageUrl,
    mediaId: proof.mediaId,

    submittedAt: proof.submittedAt.toISOString(),
    submittedBy: proof.submittedBy,

    reviewedAt: proof.reviewedAt?.toISOString() ?? null,
    reviewedBy: proof.reviewedBy,
    reviewedByName: proof.reviewedByName,
    reviewNote: proof.reviewNote,
    paymentId: proof.paymentId,

    ...(proof.order
      ? {
          order: {
            orderNumber: proof.order.orderNumber,
            email: proof.order.email,
            total: money(proof.order.totalCents, proof.order.currency),
            status: proof.order.status,
          },
        }
      : {}),
  }
}
