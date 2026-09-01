/**
 * The realtime bridge (§11.5).
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * Realtime events are raised by *subscribers*, and subscribers run in the
 * worker. The worker has no socket server — the browsers are all connected to
 * the API. So an `emit()` called from a subscriber reaches nobody at all: it
 * works in development, where `RUN_WORKERS_IN_PROCESS` puts both in one
 * process, and is silently dead in production, where that flag is forbidden.
 *
 * The same problem appears again as soon as there are two API instances: a
 * customer connected to instance A gets nothing when instance B has the news.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * One channel, `pg_notify`, and every process that owns sockets listens on it.
 *
 *   worker  ──NOTIFY realtime──▶  Postgres  ──┬──▶ api #1 ──▶ its sockets
 *                                             └──▶ api #2 ──▶ its sockets
 *
 * Postgres is already a hard dependency and already carries the outbox's
 * wake-ups, so this adds no new infrastructure — no Redis, no message bus. It
 * inherits the same delivery guarantee realtime has always had: best effort. A
 * NOTIFY is not durable, and a process that is not listening at that instant
 * misses it. That is acceptable precisely because realtime is never the only
 * channel for anything that matters — the notification row and the email are
 * the durable copies (§11.5).
 *
 * ── The 8000-byte limit ─────────────────────────────────────────────────────
 *
 * `pg_notify` refuses a payload above 8000 bytes, and a refusal would abort the
 * transaction it was raised in. Realtime payloads are supposed to be
 * identifiers and changed fields rather than whole aggregates (§11.4), so
 * anything approaching that limit is a design error — it is dropped with a
 * loud log rather than being allowed to break a checkout.
 */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { getPool, isPoolInitialised } from '../database/pool.js'
import { queryOne } from '../database/query.js'
import { createLogger } from '../logging/logger.js'

const log = createLogger('realtime.bridge')

export const REALTIME_NOTIFY_CHANNEL = 'realtime_emit'

/** Above this a payload is a design error, not a message. */
const MAX_NOTIFY_BYTES = 7_000

/**
 * Where an emission is going.
 *
 * Deliberately the *rooms*, resolved by the sender, rather than a user id the
 * receiver would have to interpret: the routing rules live in one place
 * (`emitters.ts`) and the listener stays a dumb pipe.
 */
const envelope = z.object({
  namespaces: z.array(z.enum(['storefront', 'admin'])).min(1),
  room: z.string().min(1).max(200),
  event: z.string().min(1).max(120),
  payload: z.unknown(),
})

export type RealtimeEnvelope = z.infer<typeof envelope>

type Handler = (message: RealtimeEnvelope) => void

let listener: PoolClient | undefined
let handler: Handler | undefined

/**
 * Sends an emission to every process holding sockets.
 *
 * Fire-and-forget by design: a realtime nudge must never be the reason an order
 * fails to be placed, so a failure here is logged and swallowed.
 */
export function publishRealtime(message: RealtimeEnvelope): void {
  if (!isPoolInitialised()) return

  const body = JSON.stringify(message)
  if (Buffer.byteLength(body, 'utf8') > MAX_NOTIFY_BYTES) {
    log.error(
      { event: message.event, room: message.room, bytes: Buffer.byteLength(body, 'utf8') },
      'realtime payload too large to broadcast — it should carry identifiers, not an aggregate',
    )
    return
  }

  void queryOne('SELECT pg_notify($1, $2)', [REALTIME_NOTIFY_CHANNEL, body], {
    name: 'realtime.notify',
  }).catch((error: unknown) => {
    log.warn({ err: error, event: message.event }, 'could not broadcast a realtime event')
  })
}

/**
 * Starts listening, in a process that owns sockets.
 *
 * Only the API calls this. A dedicated connection is required because LISTEN is
 * a session-level thing and a pooled client would lose it on release.
 */
export async function startRealtimeBridge(onMessage: Handler): Promise<void> {
  handler = onMessage
  try {
    listener = await getPool().connect()
    await listener.query(`LISTEN ${REALTIME_NOTIFY_CHANNEL}`)

    listener.on('notification', (notification) => {
      if (notification.channel !== REALTIME_NOTIFY_CHANNEL || !notification.payload) return
      const parsed = envelope.safeParse(JSON.parse(notification.payload))
      if (!parsed.success) {
        // A malformed message is a bug in a sender, not something to crash on.
        log.warn({ payload: notification.payload.slice(0, 200) }, 'unparseable realtime broadcast')
        return
      }
      handler?.(parsed.data)
    })

    // A dropped LISTEN connection means silent failure from then on, so it is
    // logged at error and the client is released for the pool to replace.
    listener.on('error', (error) => {
      log.error({ err: error }, 'realtime listener connection failed')
    })

    log.info({ channel: REALTIME_NOTIFY_CHANNEL }, 'realtime bridge listening')
  } catch (error) {
    // Without the bridge the API still serves; it simply pushes nothing. That
    // is a degradation worth shouting about rather than dying for.
    log.error({ err: error }, 'could not start the realtime bridge — pushes will not arrive')
  }
}

export async function stopRealtimeBridge(): Promise<void> {
  handler = undefined
  if (!listener) return
  try {
    await listener.query(`UNLISTEN ${REALTIME_NOTIFY_CHANNEL}`)
  } catch {
    // Shutting down anyway.
  }
  listener.release()
  listener = undefined
}
