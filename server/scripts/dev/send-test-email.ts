/**
 * Operational smoke test for a new environment.
 *
 * Pushes one message through the real pipeline — row → queue → worker →
 * provider — so that provider credentials, template rendering and the worker
 * can be verified without waiting for a business event.
 *
 *   node --import tsx scripts/dev/send-test-email.ts you@example.com
 *
 * The worker must be running (`npm run dev` or `npm run dev:worker`) for the
 * queued job to be picked up.
 */
import { closePool, initPool } from '../../src/infrastructure/database/pool.js'
import { startQueue, stopQueue } from '../../src/infrastructure/queue/boss.js'
import { emailService } from '../../src/infrastructure/email/email.service.js'
import { env } from '../../src/config/index.js'

const to = process.argv[2] ?? env.EMAIL_FROM

initPool('worker')
// Sender mode: this script enqueues, it does not process.
await startQueue({ supervise: false, schedule: false })

const result = await emailService.enqueue({
  to,
  template: 'system-check',
  props: { environment: env.APP_ENV, triggeredAt: new Date().toISOString() },
  dedupeKey: `system-check:${Date.now()}`,
})

console.log(`Queued ${result.status} message ${result.id} to ${to}`)

await stopQueue()
await closePool()
