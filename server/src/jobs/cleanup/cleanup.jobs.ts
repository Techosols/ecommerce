/**
 * Maintenance jobs (§8.4).
 *
 * Only the two whose tables exist in this phase. Each remaining `cleanup.*` job
 * ships with the migration that creates its table.
 */
import { IDEMPOTENCY_TTL_HOURS } from '../../config/index.js'
import { execute } from '../../infrastructure/database/query.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

/** Expired idempotency records are no longer replayable, so they are dead weight. */
export async function cleanupIdempotencyHandler(_payload: object, ctx: JobContext): Promise<void> {
  const deleted = await execute('DELETE FROM idempotency_keys WHERE expires_at < now()', [], {
    name: 'cleanup.idempotency',
  })
  ctx.logger.info({ deleted, ttlHours: IDEMPOTENCY_TTL_HOURS }, 'expired idempotency keys removed')
}

/**
 * Trims the event log past its retention window (§16.10). Only dispatched rows
 * are eligible — an undispatched event is still owed to its subscribers no
 * matter how old it is.
 */
export async function cleanupEventsHandler(
  payload: { retentionDays: number },
  ctx: JobContext,
): Promise<void> {
  const deleted = await execute(
    `DELETE FROM domain_events
      WHERE dispatched_at IS NOT NULL
        AND occurred_at < now() - ($1 || ' days')::interval`,
    [payload.retentionDays],
    { name: 'cleanup.events' },
  )
  ctx.logger.info({ deleted, retentionDays: payload.retentionDays }, 'old domain events removed')
}
