/**
 * The subscriber registry (§12.3).
 *
 * This is the one place where cross-feature reactions are visible on a single
 * screen. Subscribers are thin: they translate an event into a job or an emit.
 * The real work happens in the job handler, where retry and backoff apply.
 *
 * Every subscriber must be idempotent — outbox dispatch is at-least-once.
 */
import { createLogger } from '../../infrastructure/logging/logger.js'
import { notificationsService } from '../../features/notifications/index.js'
import type { EventName, EventPayload } from '../catalog.js'
import { registerAuthSubscribers } from './auth.subscribers.js'
import { registerCatalogueSubscribers } from './catalogue.subscribers.js'
import { registerInventorySubscribers } from './inventory.subscribers.js'
import { registerOrderSubscribers } from './orders.subscribers.js'

const log = createLogger('events.subscribers')

export interface EventEnvelope<E extends EventName = EventName> {
  id: number
  eventId: string
  name: E
  payload: EventPayload<E>
  aggregateType: string
  aggregateId: string | null
  actorUserId: string | null
  occurredAt: Date
}

export type Subscriber<E extends EventName> = (event: EventEnvelope<E>) => Promise<void>

type SubscriberMap = { [E in EventName]?: Subscriber<E>[] }

const subscribers: SubscriberMap = {}

export function on<E extends EventName>(name: E, handlers: Subscriber<E>[]): void {
  const existing = (subscribers[name] ?? []) as Subscriber<E>[]
  subscribers[name] = [...existing, ...handlers] as SubscriberMap[E]
  log.debug({ event: name, count: handlers.length }, 'subscribers registered')
}

export function getSubscribers<E extends EventName>(name: E): Subscriber<E>[] {
  return (subscribers[name] ?? []) as Subscriber<E>[]
}

/** Test helper: drop every registration. */
export function clearSubscribers(): void {
  for (const key of Object.keys(subscribers)) {
    delete subscribers[key as EventName]
  }
}

/**
 * Wires up every subscriber. Called once by the worker at startup, and by the
 * API when it hosts the worker in development.
 *
 * Each feature contributes a `register*Subscribers()` function, so this file
 * stays a table of contents rather than growing into a dumping ground.
 */
export function registerSubscribers(): void {
  registerInfrastructureSubscribers()
  registerAuthSubscribers()
  registerCatalogueSubscribers()
  registerInventorySubscribers()
  registerOrderSubscribers()
}

function registerInfrastructureSubscribers(): void {
  on('job.dead_lettered', [
    async (event) => {
      // Staff are told as well as logged: a job that has exhausted its retries
      // is usually invisible until someone notices its effect is missing.
      await notificationsService.notifyStaff({
        type: 'job.dead_lettered',
        title: `A background job failed: ${event.payload.queue}`,
        body: `${event.payload.attempts} attempt(s) exhausted. ${event.payload.error ?? ''}`.trim(),
        data: { queue: event.payload.queue, jobId: event.payload.jobId },
        dedupeKey: `job-dead-lettered:${event.payload.jobId}`,
      })
      log.error(
        {
          queue: event.payload.queue,
          jobId: event.payload.jobId,
          attempts: event.payload.attempts,
          error: event.payload.error,
        },
        'job dead-lettered — operator attention required',
      )
    },
  ])
}
