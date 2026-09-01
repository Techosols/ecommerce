/**
 * `carts.abandoned_scan` (§8.4).
 *
 * A cart nobody has touched since its expiry is abandoned. Two reasons this
 * matters beyond tidiness:
 *
 *   • it raises `cart.abandoned`, which is what a recovery email hangs off
 *   • an abandoned cart stops occupying the "one active cart per customer"
 *     slot, so the customer's next visit starts cleanly rather than resuming a
 *     three-week-old basket of things that have since changed price
 *
 * Bounded per run and driven by `FOR UPDATE SKIP LOCKED`, so two workers can
 * run it at once without fighting over the same rows and without either of
 * them blocking.
 */
import { cartsService } from '../../features/carts/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export async function abandonCartsHandler(
  payload: { batchSize: number },
  ctx: JobContext,
): Promise<void> {
  let abandoned = 0

  // Several passes, so a backlog is worked off within one run rather than one
  // batch per hour — but bounded, so a huge backlog does not hold the worker.
  for (let pass = 0; pass < 20; pass += 1) {
    if (ctx.signal.aborted) break
    const count = await cartsService.abandonExpired(payload.batchSize)
    abandoned += count
    if (count < payload.batchSize) break
  }

  if (abandoned > 0) ctx.logger.info({ abandoned }, 'expired carts marked abandoned')
  else ctx.logger.debug('no carts were due to be abandoned')
}
