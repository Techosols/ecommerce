/**
 * Payment proofs — the rules (§5.7).
 *
 * ── The one idea worth holding on to ─────────────────────────────────────────
 *
 * **A proof is evidence, not money.** Nothing a customer submits here reaches
 * the ledger. Approving a proof calls the same `recordPayment` a staff member
 * uses to mark an order paid, for the order's own outstanding balance computed
 * from the order — so an approved proof and a staff "mark as paid" produce
 * exactly the same payment row, the same audit entry and the same confirmation.
 * The proof is the reason somebody pressed the button; it is not the amount.
 *
 * That is what keeps this safe while the details are typed by an anonymous
 * person on the internet. The worst a forged screenshot can do is waste a
 * reviewer's time. It cannot move a number.
 *
 * ── Why submission is not authenticated ──────────────────────────────────────
 *
 * Most of these orders are guest orders; the customer is working from the
 * confirmation page or an order-lookup link. Requiring an account would mean
 * requiring registration to pay, which is the opposite of what the method is
 * for. Instead the route is scoped the way the guest order lookup already is —
 * the order number *and* the email it was placed with — and rate limited. That
 * is the same key the shop already trusts to show somebody their own order.
 */
import { v7 as uuidv7 } from 'uuid'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { mediaService } from '../media/index.js'
import { proofsRepository as repo } from './proofs.repository.js'
import type { PaymentProof, PaymentProofStatus } from './proofs.types.js'

const log = createLogger('payments.proofs')

/** How many attempts one order may accumulate before staff have to intervene. */
const MAX_ATTEMPTS_PER_ORDER = 10

export interface SubmitProofInput {
  orderId: string
  mediaId: string
  senderName: string
  senderBank: string
  accountLast4?: string | null
  submittedBy?: string | null
}

export const proofsService = {
  async listForOrder(orderId: string): Promise<PaymentProof[]> {
    return repo.listForOrder(orderId)
  },

  async getById(id: string): Promise<PaymentProof> {
    const proof = await repo.findById(id)
    if (!proof) throw new NotFoundError('Payment proof not found')
    return proof
  },

  async list(filter: { status?: PaymentProofStatus; limit: number; offset: number }) {
    return repo.list(filter)
  },

  async pendingCount(): Promise<number> {
    return repo.pendingCount()
  },

  /**
   * The customer says they have sent the money.
   *
   * The order must be one that is actually waiting for a bank transfer. Every
   * refusal below is a different thing having gone wrong, and a customer who
   * gets "that order is already paid" needs a different next step from one who
   * gets "you already sent us a receipt".
   */
  async submit(
    input: SubmitProofInput,
    order: {
      id: string
      paymentMethod: string
      paymentStatus: string
      status: string
    },
  ): Promise<PaymentProof> {
    if (order.paymentMethod !== 'bank_transfer') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That order was not placed to be paid by bank transfer',
      )
    }
    if (order.status === 'cancelled') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That order has been cancelled',
      )
    }
    if (order.paymentStatus === 'paid') {
      throw new DomainRuleError(ERROR_CODES.DOMAIN_RULE_VIOLATION, 'That order is already paid')
    }

    // The image must exist and have survived processing. Accepting a `pending`
    // asset would put a proof in the queue whose screenshot may never arrive,
    // and the reviewer would have nothing to look at.
    const asset = await mediaService.getById(input.mediaId)
    if (!asset || asset.status !== 'ready') {
      throw new ValidationError('The receipt image has not finished uploading')
    }

    const existing = await repo.listForOrder(order.id)
    if (existing.some((proof) => proof.status === 'submitted')) {
      throw new ConflictError('You have already sent us a receipt for this order', {
        code: ERROR_CODES.ALREADY_EXISTS,
      })
    }
    if (existing.length >= MAX_ATTEMPTS_PER_ORDER) {
      // Not a security control — the route is rate limited — but a stop on a
      // loop that would otherwise fill the queue with one order's attempts.
      throw new ConflictError('Please contact us about this order instead', {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }

    const proof = await repo.create({
      id: uuidv7(),
      orderId: order.id,
      mediaId: input.mediaId,
      senderName: input.senderName.trim(),
      senderBank: input.senderBank.trim(),
      accountLast4: input.accountLast4?.trim() || null,
      submittedBy: input.submittedBy ?? null,
    })

    log.info({ proofId: proof.id, orderId: order.id }, 'payment proof submitted')
    return proof
  },

  /**
   * A member of staff has compared the screenshot against the statement.
   *
   * `recordMoney` is injected rather than imported: proofs must not reach into
   * fulfilment, which owns what "paid" does to an order. The caller binds it to
   * the same `fulfillmentService.recordPayment` the admin's own "mark as paid"
   * uses, so approving here and marking paid there are the same act — including
   * the confirmation, the audit entry and the customer's email.
   *
   * The whole thing is one transaction. A payment recorded against a proof that
   * stayed `submitted` would be money in the ledger and an order still sitting
   * in the review queue, which is the one outcome worth being careful about.
   */
  async approve(
    proofId: string,
    actor: Actor,
    recordMoney: (orderId: string) => Promise<{ id: string }>,
  ): Promise<PaymentProof> {
    const proof = await this.getById(proofId)
    if (proof.status !== 'submitted') {
      throw new ConflictError(`That receipt has already been ${proof.status}`, {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }

    await withTransaction(async () => {
      const payment = await recordMoney(proof.orderId)

      // Conditional on still being `submitted`, so if a colleague approved it
      // between the read above and here, this affects no rows and the whole
      // transaction — the payment included — rolls back.
      const decided = await repo.decide({
        id: proofId,
        status: 'approved',
        reviewedBy: actor.userId,
        reviewedByName: actor.email,
        reviewNote: null,
        paymentId: payment.id,
      })
      if (!decided) {
        throw new ConflictError('Somebody else reviewed that receipt just now', {
          code: ERROR_CODES.CONCURRENT_MODIFICATION,
        })
      }
    })

    log.info({ proofId, actorId: actor.userId }, 'payment proof approved')
    return this.getById(proofId)
  },

  /**
   * Not this one.
   *
   * The note is required by the database and by this signature, because it is
   * shown to the customer: "rejected" on its own tells somebody who believes
   * they have paid nothing about what to do next. Rejecting leaves the order
   * unpaid and lets them submit again — the partial unique index only forbids
   * two *pending* proofs, not two attempts.
   */
  async reject(proofId: string, note: string, actor: Actor): Promise<PaymentProof> {
    const reason = note.trim()
    if (!reason) throw new ValidationError('Say why, so the customer knows what to do next')

    const proof = await this.getById(proofId)
    if (proof.status !== 'submitted') {
      throw new ConflictError(`That receipt has already been ${proof.status}`, {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }

    const decided = await repo.decide({
      id: proofId,
      status: 'rejected',
      reviewedBy: actor.userId,
      reviewedByName: actor.email,
      reviewNote: reason,
      paymentId: null,
    })
    if (!decided) {
      throw new ConflictError('Somebody else reviewed that receipt just now', {
        code: ERROR_CODES.CONCURRENT_MODIFICATION,
      })
    }

    log.info({ proofId, actorId: actor.userId }, 'payment proof rejected')
    return this.getById(proofId)
  },
}
