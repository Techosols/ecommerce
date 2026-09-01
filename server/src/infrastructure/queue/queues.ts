/**
 * Queue registry (§9.2).
 *
 * A queue exists here only once it has a handler. The names reserved by the
 * architecture for later phases are listed at the bottom of this file so the
 * naming stays consistent, but declaring a queue nobody works is dead config.
 *
 * Every queue's payload has a Zod schema. `enqueue()` validates before sending
 * and the handler parses again on receipt, so a malformed payload fails at the
 * producer — where the stack trace is useful — rather than silently in a worker.
 */
import { z } from 'zod'

export const QUEUES = {
  EMAIL_SEND: 'email.send',
  CLEANUP_IDEMPOTENCY: 'cleanup.idempotency',
  CLEANUP_EVENTS: 'cleanup.events',
  CLEANUP_SESSIONS: 'cleanup.sessions',
  MEDIA_PROCESS_IMAGE: 'media.process_image',
  CLEANUP_MEDIA: 'cleanup.media',
  INVENTORY_EXPIRE_RESERVATIONS: 'inventory.expire_reservations',
  CARTS_ABANDONED_SCAN: 'carts.abandoned_scan',
  ORDER_EXPIRE_UNPAID: 'order.expire_unpaid',
  ANALYTICS_ROLLUP: 'analytics.rollup',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/** Dead-letter queue name for a queue (§8.3). */
export function deadLetterName(queue: QueueName): string {
  return `${queue}.dlq`
}

export const JOB_SCHEMAS = {
  [QUEUES.EMAIL_SEND]: z.object({ emailMessageId: z.uuid() }),
  [QUEUES.CLEANUP_IDEMPOTENCY]: z.object({}).default({}),
  [QUEUES.CLEANUP_EVENTS]: z.object({ retentionDays: z.number().int().positive().default(365) }),
  [QUEUES.CLEANUP_SESSIONS]: z.object({
    loginAttemptRetentionDays: z.number().int().positive().default(90),
  }),
  [QUEUES.MEDIA_PROCESS_IMAGE]: z.object({ mediaAssetId: z.uuid() }),
  [QUEUES.CLEANUP_MEDIA]: z.object({
    abandonedAfterHours: z.number().int().positive().default(24),
  }),
  [QUEUES.INVENTORY_EXPIRE_RESERVATIONS]: z.object({}).default({}),
  [QUEUES.CARTS_ABANDONED_SCAN]: z.object({
    batchSize: z.number().int().positive().max(5000).default(500),
  }),
  [QUEUES.ORDER_EXPIRE_UNPAID]: z.object({
    /** Prepaid orders where the money never arrived: an abandoned checkout. */
    afterHours: z.number().int().positive().max(720).default(48),
    /**
     * COD orders nobody ever accepted. Deliberately far longer: a COD order is
     * unpaid by design, and cancelling one the shop merely has not got round to
     * is destroying real business.
     */
    codAcceptanceHours: z.number().int().positive().max(2160).default(168),
    batchSize: z.number().int().positive().max(1000).default(100),
  }),
  [QUEUES.ANALYTICS_ROLLUP]: z.object({
    /**
     * How many days back to recompute. More than one because a refund recorded
     * today changes yesterday's net figure, and rollups are recomputed rather
     * than accumulated, so re-doing a day is free.
     */
    days: z.number().int().positive().max(60).default(3),
  }),
} as const satisfies Record<QueueName, z.ZodType>

export type JobPayload<Q extends QueueName> = z.infer<(typeof JOB_SCHEMAS)[Q]>

export interface QueuePolicy {
  retryLimit: number
  retryDelay: number
  retryBackoff: boolean
  /** Visibility timeout — set to roughly 3× the expected duration (§9.3). */
  expireInSeconds: number
  /** Workers pulled in parallel for this queue. */
  teamSize: number
  /** Whether a final failure should raise an operator alert (§8.3). */
  alertOnDeadLetter: boolean
}

export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  [QUEUES.EMAIL_SEND]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    teamSize: 5,
    alertOnDeadLetter: true,
  },
  [QUEUES.CLEANUP_IDEMPOTENCY]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 300,
    teamSize: 1,
    alertOnDeadLetter: false,
  },
  [QUEUES.CLEANUP_EVENTS]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 600,
    teamSize: 1,
    alertOnDeadLetter: false,
  },
  [QUEUES.CLEANUP_SESSIONS]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 300,
    teamSize: 1,
    alertOnDeadLetter: false,
  },
  [QUEUES.MEDIA_PROCESS_IMAGE]: {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // CPU-bound and measured in seconds; the visibility timeout is ~3x that.
    expireInSeconds: 180,
    teamSize: 2,
    // A failed image leaves the original intact and the asset marked failed —
    // visible in the admin, not worth paging anyone.
    alertOnDeadLetter: false,
  },
  [QUEUES.CLEANUP_MEDIA]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 600,
    teamSize: 1,
    alertOnDeadLetter: false,
  },
  [QUEUES.INVENTORY_EXPIRE_RESERVATIONS]: {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: false,
    expireInSeconds: 120,
    // One worker: the sweep is idempotent, but a second one would only contend
    // for the same rows.
    teamSize: 1,
    // Stock held by dead reservations is stock that cannot be sold, so this one
    // does warrant attention if it keeps failing.
    alertOnDeadLetter: true,
  },
  [QUEUES.CARTS_ABANDONED_SCAN]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 300,
    teamSize: 1,
    alertOnDeadLetter: false,
  },
  [QUEUES.ORDER_EXPIRE_UNPAID]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: false,
    expireInSeconds: 300,
    teamSize: 1,
    // Cancelling an unpaid order returns its stock, so a sweep that keeps
    // failing is stock quietly held by orders nobody is going to pay for.
    alertOnDeadLetter: true,
  },
  [QUEUES.ANALYTICS_ROLLUP]: {
    retryLimit: 3,
    retryDelay: 120,
    retryBackoff: true,
    // Recomputing a few days scans a bounded slice of orders; generous, but a
    // rollup is idempotent so a re-run after a timeout is harmless.
    expireInSeconds: 900,
    teamSize: 1,
    // A stale dashboard is visible and not urgent.
    alertOnDeadLetter: false,
  },
}

/** Cron schedules, in UTC (§8.4). */
export const QUEUE_SCHEDULES: { queue: QueueName; cron: string; data?: unknown }[] = [
  { queue: QUEUES.CLEANUP_IDEMPOTENCY, cron: '0 4 * * *' },
  { queue: QUEUES.CLEANUP_EVENTS, cron: '30 4 * * *', data: { retentionDays: 365 } },
  { queue: QUEUES.CLEANUP_SESSIONS, cron: '15 4 * * *', data: { loginAttemptRetentionDays: 90 } },
  { queue: QUEUES.CLEANUP_MEDIA, cron: '45 4 * * *', data: { abandonedAfterHours: 24 } },
  // Every five minutes, not nightly: stock held by an abandoned checkout is
  // stock the shop cannot sell, and the cost of a late release is a lost sale.
  { queue: QUEUES.INVENTORY_EXPIRE_RESERVATIONS, cron: '*/5 * * * *' },
  // Hourly rather than nightly: an abandoned cart is worth an email while the
  // shopper might still come back, and the sweep is cheap and idempotent.
  { queue: QUEUES.CARTS_ABANDONED_SCAN, cron: '0 * * * *', data: { batchSize: 500 } },
  {
    queue: QUEUES.ORDER_EXPIRE_UNPAID,
    cron: '20 * * * *',
    data: { afterHours: 48, codAcceptanceHours: 168, batchSize: 100 },
  },
  // After the cleanup jobs, so the day is settled before it is counted.
  { queue: QUEUES.ANALYTICS_ROLLUP, cron: '0 5 * * *', data: { days: 3 } },
]

/*
 * Reserved for later phases — added here when their handler lands:
 *   notification.dispatch
 *   inventory.low_stock_scan  inventory.reconcile
 *   payment.check_pending  shipment.delivery_check    webhook.process
 *   webhook.sweep          customer.claim_guest_orders
 *   analytics.ingest       report.generate
 *   cleanup.carts          cleanup.analytics
 */
