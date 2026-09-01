/**
 * `cleanup.sessions` (§8.4).
 *
 * Sessions, credential tokens and login attempts all accumulate. None of them
 * is needed once it is well past its usefulness, and a revoked session kept
 * forever is a growing index for no benefit.
 *
 * Retention is deliberately generous rather than aggressive: a revoked session
 * is evidence about how an account was used, and 30 days is long enough to
 * answer "what happened last month" without the table growing without bound.
 */
import { authService } from '../../features/auth/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export async function cleanupSessionsHandler(
  payload: { loginAttemptRetentionDays: number },
  ctx: JobContext,
): Promise<void> {
  const sessions = await authService.purgeExpiredSessions()
  const tokens = await authService.purgeExpiredAuthTokens()
  const attempts = await authService.purgeOldLoginAttempts(payload.loginAttemptRetentionDays)

  ctx.logger.info(
    { sessions, tokens, attempts, loginAttemptRetentionDays: payload.loginAttemptRetentionDays },
    'auth records cleaned up',
  )
}
