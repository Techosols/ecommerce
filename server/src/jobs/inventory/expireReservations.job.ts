/**
 * `inventory.expire_reservations` (§8.4).
 *
 * An abandoned checkout holds stock. Without this job that stock is held
 * forever, and a shop slowly stops being able to sell things it physically has
 * — the failure mode is invisible until someone counts the shelf and the system
 * disagrees.
 *
 * Runs often, because the cost of a late release is a lost sale. Bounded per
 * run so a backlog is worked off over several passes rather than in one long
 * transaction, and it honours the shutdown signal.
 */
import { reservationsService } from '../../features/inventory/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

/** Small batches: each expiry is its own transaction, and locks should be brief. */
const BATCH = 100

export async function expireReservationsHandler(
  _payload: Record<string, never>,
  ctx: JobContext,
): Promise<void> {
  let expired = 0

  // Several passes per run, so a burst of abandoned checkouts is cleared
  // promptly rather than at BATCH per five minutes.
  for (let pass = 0; pass < 10; pass += 1) {
    if (ctx.signal.aborted) break
    const count = await reservationsService.expireDue(BATCH)
    expired += count
    if (count < BATCH) break
  }

  if (expired > 0) {
    ctx.logger.info({ expired }, 'expired reservations released stock back')
  } else {
    ctx.logger.debug('no reservations were due to expire')
  }
}
