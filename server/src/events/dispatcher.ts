/**
 * The outbox dispatcher (§12.1).
 *
 *   claim a batch  →  fan out to subscribers  →  mark dispatched
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` against the partial index of
 * undispatched rows, so several dispatchers could run without stepping on each
 * other and the scan stays small however large the event log grows.
 *
 * Delivery is at-least-once: an event whose subscribers partly failed is
 * retried whole, which is why every subscriber must be idempotent. After
 * `EVENT_MAX_DISPATCH_ATTEMPTS` the event is parked (marked dispatched, with
 * the error preserved) so one poison event cannot wedge the queue.
 */
import type { PoolClient } from 'pg'
import { EVENT_MAX_DISPATCH_ATTEMPTS, env } from '../config/index.js'
import { getPool } from '../infrastructure/database/pool.js'
import { query } from '../infrastructure/database/query.js'
import { withTransaction } from '../infrastructure/database/transaction.js'
import { runWithContext } from '../infrastructure/logging/context.js'
import { createLogger } from '../infrastructure/logging/logger.js'
import { isKnownEvent, type EventName } from './catalog.js'
import { EVENT_NOTIFY_CHANNEL } from './publish.js'
import { getSubscribers, type EventEnvelope } from './subscribers/index.js'

const log = createLogger('events.dispatcher')

interface EventRow {
  id: number
  event_id: string
  name: string
  aggregate_type: string
  aggregate_id: string | null
  payload: unknown
  actor_user_id: string | null
  request_id: string | null
  occurred_at: Date
  attempts: number
}

/**
 * Processes one batch. Exported so tests can drive a single deterministic pass
 * instead of racing a timer.
 *
 * @returns the number of events processed.
 */
export async function dispatchBatch(batchSize = env.EVENT_DISPATCH_BATCH_SIZE): Promise<number> {
  return withTransaction(async (tx) => {
    const rows = await query<EventRow>(
      `SELECT id, event_id, name, aggregate_type, aggregate_id, payload,
              actor_user_id, request_id, occurred_at, attempts
         FROM domain_events
        WHERE dispatched_at IS NULL
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
      { name: 'events.claimBatch', executor: tx.client },
    )

    for (const row of rows) {
      await dispatchOne(row, tx.client)
    }
    return rows.length
  })
}

async function dispatchOne(row: EventRow, client: PoolClient): Promise<void> {
  const attempt = row.attempts + 1

  await runWithContext(
    {
      requestId: row.request_id ?? row.event_id,
      ...(row.actor_user_id ? { userId: row.actor_user_id } : {}),
    },
    async () => {
      if (!isKnownEvent(row.name)) {
        // An event published by a newer deploy than this process. Park it
        // rather than retrying forever; the row remains for a replay later.
        log.warn({ event: row.name, eventId: row.event_id }, 'unknown event name, parking')
        await markDispatched(client, row.id, 'unknown event name')
        return
      }

      const envelope: EventEnvelope = {
        id: row.id,
        eventId: row.event_id,
        name: row.name as EventName,
        payload: row.payload as never,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        actorUserId: row.actor_user_id,
        occurredAt: row.occurred_at,
      }

      const handlers = getSubscribers(envelope.name)
      const failures: string[] = []

      // Each subscriber is isolated: one failing must not stop its siblings.
      for (const handler of handlers) {
        try {
          await handler(envelope as never)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(message)
          log.error(
            { err: error, event: envelope.name, eventId: envelope.eventId, attempt },
            'event subscriber failed',
          )
        }
      }

      if (failures.length === 0) {
        await markDispatched(client, row.id, null)
        log.debug(
          { event: envelope.name, eventId: envelope.eventId, subscribers: handlers.length },
          'event dispatched',
        )
        return
      }

      if (attempt >= EVENT_MAX_DISPATCH_ATTEMPTS) {
        log.error(
          { event: envelope.name, eventId: envelope.eventId, attempts: attempt },
          'event exhausted dispatch attempts — parking',
        )
        await markDispatched(client, row.id, failures.join('; '))
        return
      }

      await query(
        `UPDATE domain_events SET attempts = $2, last_error = $3 WHERE id = $1`,
        [row.id, attempt, failures.join('; ')],
        { name: 'events.recordFailure', executor: client },
      )
    },
  )
}

async function markDispatched(client: PoolClient, id: number, error: string | null): Promise<void> {
  await query(
    `UPDATE domain_events
        SET dispatched_at = now(),
            attempts = attempts + 1,
            last_error = $2
      WHERE id = $1`,
    [id, error],
    { name: 'events.markDispatched', executor: client },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Long-running dispatcher: a poll loop, woken early by LISTEN/NOTIFY.
// ─────────────────────────────────────────────────────────────────────────────

let running = false
let timer: NodeJS.Timeout | undefined
let listener: PoolClient | undefined
let inFlight: Promise<void> = Promise.resolve()

async function tick(): Promise<void> {
  if (!running) return
  try {
    // Keep draining while batches come back full — a burst should not wait out
    // one poll interval per batch.
    let processed = 0
    do {
      processed = await dispatchBatch()
    } while (running && processed === env.EVENT_DISPATCH_BATCH_SIZE)
  } catch (error) {
    log.error({ err: error }, 'dispatch batch failed')
  }
}

function schedule(): void {
  if (!running) return
  timer = setTimeout(() => {
    inFlight = tick().finally(schedule)
  }, env.EVENT_DISPATCH_INTERVAL_MS)
}

export async function startEventDispatcher(): Promise<void> {
  if (running) return
  running = true

  // A dedicated connection for LISTEN. Needs a session, so this only works on
  // the direct connection — the worker's pool role (§4.2).
  try {
    listener = await getPool().connect()
    await listener.query(`LISTEN ${EVENT_NOTIFY_CHANNEL}`)
    listener.on('notification', () => {
      if (timer) clearTimeout(timer)
      inFlight = tick().finally(schedule)
    })
    log.debug({ channel: EVENT_NOTIFY_CHANNEL }, 'listening for event notifications')
  } catch (error) {
    // Not fatal: polling alone is correct, just slower.
    log.warn({ err: error }, 'LISTEN unavailable; falling back to polling only')
    listener?.release()
    listener = undefined
  }

  schedule()
  log.info({ intervalMs: env.EVENT_DISPATCH_INTERVAL_MS }, 'event dispatcher started')
}

export async function stopEventDispatcher(): Promise<void> {
  if (!running) return
  running = false
  if (timer) clearTimeout(timer)
  timer = undefined

  await inFlight.catch(() => undefined)

  if (listener) {
    try {
      await listener.query(`UNLISTEN ${EVENT_NOTIFY_CHANNEL}`)
    } catch {
      // The connection may already be gone; nothing useful to do.
    }
    listener.release()
    listener = undefined
  }
  log.info('event dispatcher stopped')
}
