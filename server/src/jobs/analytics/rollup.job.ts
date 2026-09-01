/**
 * `analytics.rollup` (§8.4, §13.1).
 *
 * Recomputes the last few days of sales rollups so the dashboard reads a few
 * hundred rows instead of scanning every order ever placed.
 *
 * **Several days, not one.** A refund recorded today changes yesterday's net
 * figure, and an order placed at 23:59 can be cancelled at 00:01. Because a
 * rollup is *recomputed from source and upserted* rather than incremented,
 * re-doing a day costs one bounded query and always converges on the right
 * answer — which also makes this job safe to retry, safe to run twice, and safe
 * to run by hand for a historical correction.
 */
import { analyticsService } from '../../features/analytics/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export async function analyticsRollupHandler(
  payload: { days: number },
  ctx: JobContext,
): Promise<void> {
  const to = new Date()
  const from = new Date(to.getTime() - (payload.days - 1) * 86_400_000)

  const recomputed = await analyticsService.rollupRange(
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
  )

  ctx.logger.info(
    { days: recomputed, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    'daily sales rollups recomputed',
  )
}
