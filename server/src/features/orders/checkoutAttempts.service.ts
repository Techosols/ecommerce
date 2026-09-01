/**
 * A record of every checkout that was tried (§8.4).
 *
 * Checkout is one atomic request: it either produces an order or raises, and
 * when it raises there is nothing left behind. That is the right shape for
 * checkout and the wrong shape for a shop, which cannot otherwise see that
 * forty people failed to buy this morning because one variant went out of
 * stock at nine.
 *
 * **This is a log, not a session.** Nothing here is resumed, advanced or read
 * back by the storefront; it is written once at the end of an attempt and the
 * checkout path behaves exactly as it did before. A resumable checkout session
 * is a different feature with a different table, and inventing one on top of an
 * atomic checkout would buy a screen at the cost of a working sale.
 *
 * Recording never fails an attempt. A checkout that succeeded and whose log row
 * could not be written is still a sale, so every failure here is swallowed and
 * logged — the alternative is losing orders to a bookkeeping problem.
 */
import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { isAppError } from '../../shared/errors/index.js'

const log = createLogger('checkout.attempts')

export type AttemptOutcome = 'placed' | 'failed'

export interface CheckoutAttempt {
  id: string
  cartId: string | null
  customerId: string | null
  email: string | null
  orderId: string | null
  outcome: AttemptOutcome
  failureCode: string | null
  failureMessage: string | null
  subtotalCents: number
  itemCount: number
  paymentMethod: string | null
  countryCode: string | null
  createdAt: Date
}

interface AttemptRow {
  id: string
  cart_id: string | null
  customer_id: string | null
  email: string | null
  order_id: string | null
  outcome: AttemptOutcome
  failure_code: string | null
  failure_message: string | null
  subtotal_cents: number
  item_count: number
  payment_method: string | null
  country_code: string | null
  created_at: Date
}

function toAttempt(row: AttemptRow): CheckoutAttempt {
  return {
    id: row.id,
    cartId: row.cart_id,
    customerId: row.customer_id,
    email: row.email,
    orderId: row.order_id,
    outcome: row.outcome,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    subtotalCents: row.subtotal_cents,
    itemCount: row.item_count,
    paymentMethod: row.payment_method,
    countryCode: row.country_code,
    createdAt: row.created_at,
  }
}

export interface AttemptContext {
  cartId: string | null
  customerId: string | null
  email: string | null
  paymentMethod: string | null
  countryCode: string | null
  subtotalCents: number
  itemCount: number
}

export const checkoutAttemptsService = {
  async recordPlaced(context: AttemptContext, orderId: string): Promise<void> {
    await this.write({ ...context, outcome: 'placed', orderId })
  },

  /**
   * Records why an attempt was refused, using the server's own error code.
   *
   * The code rather than the prose: `INSUFFICIENT_STOCK` is what the API
   * refuses with and what the admin groups by, while the message is written
   * for a shopper and changes whenever somebody improves the wording. An
   * unexpected error — a bug, a dropped connection — is filed under
   * `INTERNAL_ERROR` rather than being dropped, because a checkout failing for
   * an unknown reason is the most interesting row on the page.
   */
  async recordFailure(context: AttemptContext, error: unknown): Promise<void> {
    const code = isAppError(error) ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    await this.write({
      ...context,
      outcome: 'failed',
      orderId: null,
      failureCode: code,
      failureMessage: message.slice(0, 500),
    })
  },

  async write(
    input: AttemptContext & {
      outcome: AttemptOutcome
      orderId: string | null
      failureCode?: string
      failureMessage?: string
    },
  ): Promise<void> {
    try {
      await execute(
        `INSERT INTO checkout_attempts
           (id, cart_id, customer_id, email, order_id, outcome, failure_code, failure_message,
            subtotal_cents, item_count, payment_method, country_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          uuidv7(),
          input.cartId,
          input.customerId,
          input.email,
          input.orderId,
          input.outcome,
          input.failureCode ?? null,
          input.failureMessage ?? null,
          input.subtotalCents,
          input.itemCount,
          input.paymentMethod,
          input.countryCode,
        ],
        { name: 'checkoutAttempts.write' },
      )
    } catch (error) {
      // Never propagate: an order that was placed is placed, and a failure
      // that could not be logged is still a failure the customer already saw.
      log.error({ err: error, outcome: input.outcome }, 'could not record a checkout attempt')
    }
  },

  async list(filter: {
    limit: number
    offset: number
    outcome?: AttemptOutcome
    failureCode?: string
    from?: string
    to?: string
  }): Promise<{ rows: CheckoutAttempt[]; total: number }> {
    const params: unknown[] = []
    const where: string[] = []
    const push = (value: unknown) => {
      params.push(value)
      return `$${params.length}`
    }

    if (filter.outcome) where.push(`outcome = ${push(filter.outcome)}`)
    if (filter.failureCode) where.push(`failure_code = ${push(filter.failureCode)}`)
    if (filter.from) where.push(`created_at >= ${push(filter.from)}`)
    if (filter.to) where.push(`created_at <= ${push(filter.to)}`)

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await query<AttemptRow>(
      `SELECT * FROM checkout_attempts ${clause}
        ORDER BY created_at DESC
        LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`,
      params,
      { name: 'checkoutAttempts.list' },
    )
    const totalRow = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM checkout_attempts ${clause}`,
      params.slice(0, params.length - 2),
      { name: 'checkoutAttempts.count' },
    )

    return { rows: rows.map(toAttempt), total: totalRow?.count ?? 0 }
  },

  /**
   * How checkout is doing, and what is stopping it.
   *
   * One query rather than a page of rows to count, because "17% of checkouts
   * failed" is a different question from "here are the last twenty" and
   * answering it by counting a page would make the figure depend on the pager.
   */
  async summary(window: { from: string; to: string }): Promise<{
    placed: number
    failed: number
    reasons: { code: string; count: number }[]
  }> {
    const totals = await queryOne<{ placed: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE outcome = 'placed')::int AS placed,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failed
         FROM checkout_attempts
        WHERE created_at >= $1 AND created_at <= $2`,
      [window.from, window.to],
      { name: 'checkoutAttempts.summary' },
    )

    const reasons = await query<{ failure_code: string; count: number }>(
      `SELECT failure_code, count(*)::int AS count
         FROM checkout_attempts
        WHERE outcome = 'failed' AND created_at >= $1 AND created_at <= $2
        GROUP BY failure_code
        ORDER BY count DESC
        LIMIT 10`,
      [window.from, window.to],
      { name: 'checkoutAttempts.reasons' },
    )

    return {
      placed: totals?.placed ?? 0,
      failed: totals?.failed ?? 0,
      reasons: reasons.map((row) => ({ code: row.failure_code, count: row.count })),
    }
  },
}
