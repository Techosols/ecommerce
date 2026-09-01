/**
 * Reactions to identity and authentication events (§12.3).
 *
 * Subscribers are thin: translate an event into a job or an invalidation. They
 * run in the dispatcher, are retried as a batch, and must therefore be
 * idempotent — every email here carries a deterministic `dedupe_key`, so a
 * redelivered event produces one message, not two.
 *
 * Note what is deliberately *not* here: the verification and password-reset
 * emails. Those carry a one-time secret, and an event payload is written to
 * `domain_events`, which is durable and queryable. Putting a live reset token
 * there would be a standing credential leak, so `auth.service` enqueues those
 * two directly after the transaction commits. The events still fire — carrying
 * the token id — so monitoring and audit see the action.
 */
import { env } from '../../config/index.js'
import { emailService } from '../../infrastructure/email/index.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { usersService } from '../../features/users/index.js'
import { ordersRepository } from '../../features/orders/index.js'
import { on } from './index.js'

const log = createLogger('events.auth')

export function registerAuthSubscribers(): void {
  // A confirmed address is the moment to welcome someone — not registration,
  // which would mean two emails in one second.
  on('customer.email_verified', [
    async (event) => {
      const user = await usersService.getById(event.payload.userId)
      if (!user) return
      await emailService.enqueue({
        to: user.email,
        template: 'welcome',
        props: {
          ...(user.firstName ? { firstName: user.firstName } : {}),
          storeUrl: env.CLIENT_ORIGIN,
        },
        dedupeKey: `welcome:${user.id}`,
      })

      // Orders this person placed as a guest, before they had an account, now
      // belong to them and appear in their order history.
      //
      // Deliberately here and not on `customer.registered`: matching on an
      // email address alone would let anyone claim a stranger's purchase
      // history by typing their address at sign-up. Verification is the proof
      // that the address is theirs, so it is the earliest safe moment.
      const claimed = await ordersRepository.claimGuestOrders(user.id, user.email)
      if (claimed > 0) {
        log.info({ userId: user.id, claimed }, 'guest orders attached to a verified account')
      }
    },
  ])

  // A security notice, not a courtesy: it is how a user finds out their account
  // was taken over, so it goes to the address on file even for a reset.
  on('auth.password_changed', [
    async (event) => {
      const user = await usersService.getById(event.payload.userId)
      if (!user) return
      await emailService.enqueue({
        to: user.email,
        template: 'password-changed',
        props: {
          action: event.payload.method === 'reset' ? 'reset' : 'changed',
          changedAt: event.occurredAt.toISOString(),
          supportUrl: `${env.CLIENT_ORIGIN}/support`,
        },
        dedupeKey: `password-changed:${event.eventId}`,
      })
    },
  ])

  // Role and status changes invalidate the per-user access cache in *this*
  // process. The worker and the API are separate processes, so each one
  // reacting to the same event is what keeps both correct — and the 30-second
  // TTL is the backstop if a dispatch is delayed.
  on('user.roles_changed', [
    async (event) => {
      usersService.invalidateAccess(event.payload.userId)
    },
  ])

  on('user.status_changed', [
    async (event) => {
      usersService.invalidateAccess(event.payload.userId)
    },
  ])

  // Security events have no automated response yet — notifications arrive in
  // Phase 10. Until then an operator-visible log line is the alert, and the
  // event row itself is the durable record.
  on('auth.token_reuse_detected', [
    async (event) => {
      log.error(
        {
          userId: event.payload.userId,
          familyId: event.payload.familyId,
          sessionsRevoked: event.payload.sessionsRevoked,
          ip: event.payload.ip,
        },
        'SECURITY: refresh token reuse detected — session family revoked',
      )
    },
  ])

  on('auth.account_locked', [
    async (event) => {
      log.warn(
        { userId: event.payload.userId, failures: event.payload.failures },
        'SECURITY: account locked after repeated failed logins',
      )
    },
  ])
}
