/**
 * Publishing a domain event (§12.1).
 *
 * The event row is written with the ambient executor, so when it is called
 * inside `withTransaction` it commits or rolls back with the business data.
 * That is the whole point of the outbox: an event can never exist for work that
 * rolled back, and committed work can never lose its event.
 *
 * After the transaction commits, `pg_notify` wakes the dispatcher so latency is
 * milliseconds rather than a poll interval. The notify is an optimisation; the
 * poll is the mechanism, so a missed notification costs latency, not delivery.
 */
import { v7 as uuidv7 } from 'uuid'
import { getContext } from '../infrastructure/logging/context.js'
import { createLogger } from '../infrastructure/logging/logger.js'
import { queryOne } from '../infrastructure/database/query.js'
import { isInTransaction } from '../infrastructure/database/transaction.js'
import { EVENT_AGGREGATES, EVENT_SCHEMAS, type EventName, type EventPayload } from './catalog.js'

const log = createLogger('events.publish')

export const EVENT_NOTIFY_CHANNEL = 'domain_events_new'

export interface PublishOptions {
  /** The row this event is about; indexed for "what happened to X" queries. */
  aggregateId?: string
  actorUserId?: string
}

export interface PublishedEvent {
  id: number
  eventId: string
  name: EventName
}

export async function publish<E extends EventName>(
  name: E,
  payload: EventPayload<E>,
  options: PublishOptions = {},
): Promise<PublishedEvent> {
  const parsed = EVENT_SCHEMAS[name].parse(payload)
  const eventId = uuidv7()
  const ctx = getContext()

  if (!isInTransaction()) {
    // Legal, but worth noticing: outside a transaction the event is not atomic
    // with anything, which defeats the outbox guarantee.
    log.debug({ event: name }, 'event published outside a transaction')
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO domain_events
       (event_id, name, aggregate_type, aggregate_id, payload, actor_user_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      eventId,
      name,
      EVENT_AGGREGATES[name],
      options.aggregateId ?? null,
      JSON.stringify(parsed),
      options.actorUserId ?? ctx?.userId ?? null,
      ctx?.requestId ?? null,
    ],
    { name: 'events.publish' },
  )

  // Delivered to listeners at COMMIT, so this cannot wake the dispatcher for an
  // event that never lands.
  await queryOne('SELECT pg_notify($1, $2)', [EVENT_NOTIFY_CHANNEL, name], {
    name: 'events.notify',
  })

  log.debug({ event: name, eventId }, 'event published')
  return { id: row?.id ?? 0, eventId, name }
}
