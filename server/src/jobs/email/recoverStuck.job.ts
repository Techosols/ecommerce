/**
 * `email.recover_stuck` — messages left holding the claim.
 *
 * Two ways a message stops moving, both silent, both rescued here.
 *
 * ── Abandoned mid-send ───────────────────────────────────────────────────────
 *
 * `emailSendHandler` claims a row by moving it to `sending`, and that state is
 * a one-way door for everybody except the worker holding it: the claim itself
 * requires `queued`, and so does the dead-letter watcher. A worker killed
 * mid-send — a container recycled during a deploy, a dropped connection —
 * leaves a message that no retry can pick up and no failure path can record.
 *
 * ── Queued with no job behind it ─────────────────────────────────────────────
 *
 * A row can be `queued` with **zero attempts** and no error, which means no
 * worker ever looked at it. That happens when the job was consumed while the
 * transaction that wrote the row had not yet committed: the worker found
 * nothing, reported success, and the job was gone before the row existed.
 *
 * Both halves of that are now fixed — jobs are deferred until after commit, and
 * a missing row is retried rather than swallowed — but rows stranded by an
 * earlier build are still sitting there, and no amount of correct code from
 * here on will send them. This is what goes and gets them.
 *
 * ── Why a clock rather than a lock ───────────────────────────────────────────
 *
 * There is no `claimed_at` column, so "still in flight" has to be inferred from
 * `created_at`. That is sound because a message's whole working life is short
 * and bounded: it is enqueued the moment the row is written, the visibility
 * timeout is two minutes, and five retries at backing-off delays are spent
 * within a few minutes of that. Half an hour is far outside that envelope, so a
 * row older than the threshold and still `sending` is not busy — it is
 * abandoned.
 *
 * Re-queueing is safe even if that judgement is ever wrong: the send job claims
 * conditionally, so the worst case is one extra job that finds nothing to do.
 */
import { query } from '../../infrastructure/database/query.js'
import { QUEUES, enqueue } from '../../infrastructure/queue/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export interface RecoverStuckEmailsPayload {
  /** How long a message may sit in `sending` before it counts as abandoned. */
  stuckAfterMinutes: number
  batchSize: number
}

export async function recoverStuckEmailsHandler(
  payload: RecoverStuckEmailsPayload,
  ctx: JobContext,
): Promise<void> {
  // Released and read back in one statement, so two workers running the sweep
  // cannot both re-queue the same message.
  //
  // `attempts = 0` is the tell for the second case: the claim increments it, so
  // a queued row at zero has never been picked up by anybody. A queued row with
  // attempts above zero is a normal retry waiting its turn and is left alone.
  const rows = await query<{ id: string; template: string; to_email: string; attempts: number }>(
    `UPDATE email_messages
        SET status = 'queued',
            last_error = COALESCE(
              last_error,
              'Never picked up by a worker. Requeued by the recovery sweep.'
            )
      WHERE id IN (
        SELECT id FROM email_messages
         WHERE created_at < now() - make_interval(mins => $1)
           AND (status = 'sending' OR (status = 'queued' AND attempts = 0))
         ORDER BY created_at
         LIMIT $2
      )
      RETURNING id, template, to_email, attempts`,
    [payload.stuckAfterMinutes, payload.batchSize],
    { name: 'email.recoverStuck' },
  )

  if (rows.length === 0) return

  for (const row of rows) {
    await enqueue(QUEUES.EMAIL_SEND, { emailMessageId: row.id })
  }

  /**
   * `attempts` is not reset. A message that has already burned its retries
   * gets exactly one more go, and if that fails the dead-letter watcher marks
   * it `failed` — which is the outcome it should have reached in the first
   * place. Zeroing the count would put a permanently broken template into a
   * loop that never ends and never says anything.
   */
  ctx.logger.warn(
    {
      count: rows.length,
      templates: [...new Set(rows.map((row) => row.template))],
      stuckAfterMinutes: payload.stuckAfterMinutes,
    },
    'requeued emails nothing was going to send',
  )
}
