/**
 * `cleanup.media` (§8.4).
 *
 * An upload ticket that was issued but never completed leaves a `pending` row
 * and, sometimes, an orphaned object: the client uploaded the bytes and then
 * closed the tab before calling `complete`. Neither is referenced by anything,
 * and both cost storage.
 *
 * Bounded per run so a large backlog is worked off over several nights rather
 * than in one long-running job.
 */
import { mediaService } from '../../features/media/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

const BATCH = 200

export async function cleanupMediaHandler(
  payload: { abandonedAfterHours: number },
  ctx: JobContext,
): Promise<void> {
  const abandoned = await mediaService.findAbandoned(payload.abandonedAfterHours, BATCH)

  let removed = 0
  for (const asset of abandoned) {
    if (ctx.signal.aborted) break
    await mediaService.purgeAbandoned(asset)
    removed += 1
  }

  ctx.logger.info(
    { removed, examined: abandoned.length, abandonedAfterHours: payload.abandonedAfterHours },
    'abandoned media uploads swept',
  )
}
