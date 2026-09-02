/**
 * `order.expire_unpaid` (§8.4).
 *
 * An order that will never be paid holds stock the shop cannot sell. This sweep
 * cancels those, which releases the hold through the ordinary cancellation path
 * — reservations released, `order.cancelled` raised, a history row saying the
 * system did it.
 *
 * ── Two different kinds of stuck order ──────────────────────────────────────
 *
 * The distinction that matters is *when the money was ever going to arrive*.
 *
 *   **Prepaid, never paid.** Card or bank transfer, still `payment_status =
 *   'pending'` hours later: the customer walked away at the payment step. This
 *   is an abandoned checkout and is cancelled after `afterHours`.
 *
 *   **Cash on delivery, never accepted.** A COD order is *unpaid by design*
 *   until the courier comes back, so the unpaid check above would cancel every
 *   single one of them within two days. Cancelling a COD order the shop simply
 *   has not got round to accepting would be destroying real business. What is
 *   genuinely stuck is one nobody has *confirmed* — so COD is judged on
 *   `status = 'pending'`, over a much longer window.
 *
 * Getting this wrong in either direction is expensive: too eager and the shop
 * cancels orders it was going to fulfil, too lax and stock sits held by orders
 * nobody will ever pay for. Hence two predicates rather than one, and a
 * deliberately generous COD window.
 *
 * A *confirmed* COD order is never touched by either branch: its stock is
 * committed rather than reserved, so there is no hold to lose, and the shop is
 * waiting on a courier, not on a customer.
 */
import { ordersService } from '../../features/orders/index.js'
import { query } from '../../infrastructure/database/query.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export async function expireUnpaidOrdersHandler(
  payload: { afterHours: number; codAcceptanceHours: number; batchSize: number },
  ctx: JobContext,
): Promise<void> {
  // Prepaid orders where the money never arrived. `payment_method <> 'cod'`
  // matches the partial index, so this reads only the rows it can act on and
  // cannot pick up a COD order even by accident.
  //
  // The NOT EXISTS is what keeps bank transfer usable. Such an order is
  // `pending` and unpaid by definition until a human has looked at the
  // screenshot, which is exactly the shape this sweep cancels — so without
  // this, a customer who paid on Friday evening would find their order
  // cancelled before anyone opened the queue on Monday. A receipt awaiting
  // review is somebody waiting on the shop, not a shop waiting on somebody,
  // and the clock should not run against them. An order whose receipt was
  // *rejected* is fair game again: the sweep sees no pending proof and the
  // window resumes from the order's own age.
  const abandoned = await query<{ id: string; payment_method: string }>(
    `SELECT id, payment_method FROM orders o
      WHERE o.status = 'pending'
        AND o.payment_status = 'pending'
        AND o.payment_method <> 'cod'
        AND o.placed_at < now() - ($1 || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1 FROM payment_proofs pp
           WHERE pp.order_id = o.id AND pp.status = 'submitted'
        )
      ORDER BY o.placed_at
      LIMIT $2`,
    [String(payload.afterHours), payload.batchSize],
    { name: 'orders.findAbandonedUnpaid' },
  )

  // COD orders nobody ever accepted. Judged on confirmation, not on payment,
  // and over a window measured in days rather than hours.
  const unaccepted = await query<{ id: string; payment_method: string }>(
    `SELECT id, payment_method FROM orders
      WHERE status = 'pending'
        AND payment_method = 'cod'
        AND placed_at < now() - ($1 || ' hours')::interval
      ORDER BY placed_at
      LIMIT $2`,
    [String(payload.codAcceptanceHours), payload.batchSize],
    { name: 'orders.findUnacceptedCod' },
  )

  let cancelled = 0
  let codCancelled = 0

  for (const row of [...abandoned, ...unaccepted]) {
    if (ctx.signal.aborted) break
    try {
      // `null` actor: this is the system acting, and the history row records
      // `system` rather than pretending a person clicked cancel.
      await ordersService.cancel(
        row.id,
        {
          reason:
            row.payment_method === 'cod'
              ? 'Not accepted within the acceptance window'
              : 'Unpaid after the payment window',
          restock: true,
        },
        null,
        'system',
      )
      cancelled += 1
      if (row.payment_method === 'cod') codCancelled += 1
    } catch (error) {
      // One order that will not cancel — because someone paid for it or
      // accepted it a moment ago — must not stop the rest of the sweep.
      ctx.logger.warn({ orderId: row.id, err: error }, 'could not expire a stuck order')
    }
  }

  if (cancelled > 0) {
    ctx.logger.info(
      { cancelled, abandoned: cancelled - codCancelled, unacceptedCod: codCancelled },
      'stuck orders cancelled and stock released',
    )
  } else {
    ctx.logger.debug('no orders were past their window')
  }
}
