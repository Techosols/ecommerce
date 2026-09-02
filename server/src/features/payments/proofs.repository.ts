/**
 * Payment proofs — the persistence half (§5.7).
 *
 * Plain SQL over `payment_proofs`. Nothing here decides anything: the service
 * owns the rules about who may submit, what approving means, and what a
 * rejection has to say.
 */
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import type { PaymentProof, PaymentProofStatus } from './proofs.types.js'

interface ProofRow {
  id: string
  order_id: string
  status: PaymentProofStatus
  media_id: string
  sender_name: string
  sender_bank: string
  account_last4: string | null
  reviewed_at: Date | null
  reviewed_by: string | null
  reviewed_by_name: string | null
  review_note: string | null
  payment_id: string | null
  submitted_by: string | null
  submitted_at: Date
  created_at: Date
  updated_at: Date
  // Joined, for the review queue: a screenshot with no idea which order it
  // belongs to is not reviewable.
  order_number?: string
  order_email?: string
  order_total_cents?: number
  order_currency?: string
  order_status?: string
}

function toProof(row: ProofRow): PaymentProof {
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    mediaId: row.media_id,
    senderName: row.sender_name,
    senderBank: row.sender_bank,
    accountLast4: row.account_last4,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewedByName: row.reviewed_by_name,
    reviewNote: row.review_note,
    paymentId: row.payment_id,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    ...(row.order_number === undefined
      ? {}
      : {
          order: {
            orderNumber: row.order_number,
            email: row.order_email as string,
            totalCents: row.order_total_cents as number,
            currency: row.order_currency as string,
            status: row.order_status as string,
          },
        }),
  }
}

/** The order columns the queue joins in, aliased so `toProof` can find them. */
const ORDER_JOIN = `
  o.order_number  AS order_number,
  o.email         AS order_email,
  o.total_cents   AS order_total_cents,
  o.currency      AS order_currency,
  o.status        AS order_status`

export const proofsRepository = {
  async create(input: {
    id: string
    orderId: string
    mediaId: string
    senderName: string
    senderBank: string
    accountLast4: string | null
    submittedBy: string | null
  }): Promise<PaymentProof> {
    const row = await queryOne<ProofRow>(
      `INSERT INTO payment_proofs
         (id, order_id, media_id, sender_name, sender_bank, account_last4, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.orderId,
        input.mediaId,
        input.senderName,
        input.senderBank,
        input.accountLast4,
        input.submittedBy,
      ],
      { name: 'proofs.create' },
    )
    return toProof(row as ProofRow)
  },

  async findById(id: string): Promise<PaymentProof | undefined> {
    const row = await queryOne<ProofRow>(
      `SELECT p.*, ${ORDER_JOIN}
         FROM payment_proofs p
         JOIN orders o ON o.id = p.order_id
        WHERE p.id = $1`,
      [id],
      { name: 'proofs.findById' },
    )
    return row ? toProof(row) : undefined
  },

  /** Every proof on one order, newest first — including rejected attempts. */
  async listForOrder(orderId: string): Promise<PaymentProof[]> {
    const rows = await query<ProofRow>(
      `SELECT * FROM payment_proofs WHERE order_id = $1 ORDER BY submitted_at DESC`,
      [orderId],
      { name: 'proofs.listForOrder' },
    )
    return rows.map(toProof)
  },

  /** The one awaiting review on this order, if any. At most one by index. */
  async findPendingForOrder(orderId: string): Promise<PaymentProof | undefined> {
    const row = await queryOne<ProofRow>(
      `SELECT * FROM payment_proofs WHERE order_id = $1 AND status = 'submitted'`,
      [orderId],
      { name: 'proofs.findPendingForOrder' },
    )
    return row ? toProof(row) : undefined
  },

  /**
   * The review queue.
   *
   * Ordered oldest-first when unfiltered, because it is a queue: somebody who
   * submitted this morning should not sit behind somebody who submitted just
   * now. A filtered read of decided proofs is a history, so it reads newest
   * first.
   */
  async list(filter: {
    status?: PaymentProofStatus
    limit: number
    offset: number
  }): Promise<{ rows: PaymentProof[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    if (filter.status) {
      params.push(filter.status)
      where.push(`p.status = $${params.length}`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const order =
      filter.status === 'submitted' || !filter.status
        ? 'p.status = \'submitted\' DESC, p.submitted_at ASC'
        : 'p.submitted_at DESC'

    const rows = await query<ProofRow>(
      `SELECT p.*, ${ORDER_JOIN}
         FROM payment_proofs p
         JOIN orders o ON o.id = p.order_id
         ${clause}
        ORDER BY ${order}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
      { name: 'proofs.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_proofs p ${clause}`,
      params,
      { name: 'proofs.count' },
    )
    return { rows: rows.map(toProof), total: totalRow?.count ?? 0 }
  },

  /** How many are waiting. Drives the badge on the admin's Payments link. */
  async pendingCount(): Promise<number> {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_proofs WHERE status = 'submitted'`,
      [],
      { name: 'proofs.pendingCount' },
    )
    return row?.count ?? 0
  },

  /**
   * Records a decision, but only on a proof still awaiting one.
   *
   * The `status = 'submitted'` predicate is the concurrency guard: two staff
   * opening the same queue and both pressing Approve produce one update and one
   * miss, and the service turns the miss into a conflict rather than a second
   * payment.
   */
  async decide(input: {
    id: string
    status: Exclude<PaymentProofStatus, 'submitted'>
    reviewedBy: string | null
    reviewedByName: string | null
    reviewNote: string | null
    paymentId: string | null
  }): Promise<boolean> {
    const affected = await execute(
      `UPDATE payment_proofs
          SET status = $2,
              reviewed_at = now(),
              reviewed_by = $3,
              reviewed_by_name = $4,
              review_note = $5,
              payment_id = $6
        WHERE id = $1 AND status = 'submitted'`,
      [
        input.id,
        input.status,
        input.reviewedBy,
        input.reviewedByName,
        input.reviewNote,
        input.paymentId,
      ],
      { name: 'proofs.decide' },
    )
    return affected > 0
  },
}
