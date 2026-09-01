/**
 * The only place `.emit()` is called (§11.5).
 *
 * Keeping emission here is what stops realtime leaking into business logic, and
 * it means an event raised by a background job reaches the browser through
 * exactly the same path as one raised by a request.
 *
 * ── Every emit goes through the bridge ──────────────────────────────────────
 *
 * The functions below do not touch a socket. They hand a small envelope to
 * `publishRealtime`, which broadcasts it over `pg_notify`; whichever processes
 * are holding sockets pick it up and deliver locally.
 *
 * That indirection is not ceremony. Emissions are raised by *subscribers*, and
 * subscribers run in the worker, which has no socket server — so a direct
 * `.emit()` here reached nobody in production while appearing to work in
 * development, where one process is both. It is also what makes a second API
 * instance work: a customer connected to instance A hears about something
 * instance B did.
 *
 * Feature-specific emitters are added here as their features land; they are
 * called from event subscribers, never from a controller or service.
 */
import { createLogger } from '../logging/logger.js'
import { publishRealtime, type RealtimeEnvelope } from './bridge.js'
import { getRealtime } from './server.js'
import { ROOMS } from './rooms.js'

const log = createLogger('realtime.emit')

/**
 * Delivers one broadcast to the sockets this process is holding.
 *
 * Called only by the bridge listener, in the API. A process with no socket
 * server — the worker — never reaches this.
 */
export function deliverLocally(message: RealtimeEnvelope): void {
  const io = getRealtime()
  if (!io) return

  for (const namespace of message.namespaces) {
    io.of(`/${namespace}`).to(message.room).emit(message.event, message.payload)
  }
  log.debug({ room: message.room, event: message.event }, 'realtime event delivered')
}

function broadcast(
  namespaces: RealtimeEnvelope['namespaces'],
  room: string,
  event: string,
  payload: unknown,
): void {
  publishRealtime({ namespaces, room, event, payload })
}

/** To one person, on whichever surface they are connected to. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  broadcast(['storefront', 'admin'], ROOMS.user(userId), event, payload)
}

/** To every connected staff member. */
export function emitToAdmin(event: string, payload: unknown): void {
  broadcast(['admin'], ROOMS.admin(), event, payload)
}

/** To a specific admin channel, e.g. `admin:orders`. */
export function emitToAdminRoom(room: string, event: string, payload: unknown): void {
  broadcast(['admin'], room, event, payload)
}

/** To everyone watching one order — its customer and staff. */
export function emitToOrder(orderId: string, event: string, payload: unknown): void {
  broadcast(['storefront', 'admin'], ROOMS.order(orderId), event, payload)
}
