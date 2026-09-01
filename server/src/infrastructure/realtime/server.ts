/**
 * Socket.IO server (§11).
 *
 * Two namespaces, because keeping customers and staff on separate namespaces
 * makes a broadcast to all admins impossible to deliver to a customer by
 * accident. Authentication happens in the handshake with the same access token
 * the HTTP API uses; rooms are derived server-side from the verified claims.
 *
 * Emission happens only through `emitters.ts` — no service or controller ever
 * touches `io` (§11.5).
 */
import type { Server as HttpServer } from 'node:http'
import { Server, type Namespace, type Socket } from 'socket.io'
import { env } from '../../config/index.js'
import { verifyAccessToken, type AccessTokenClaims } from '../../shared/auth/tokens.js'
import { createLogger } from '../logging/logger.js'
import { CLIENT_EVENTS, REALTIME_EVENTS, type ConnectedPayload } from './events.js'
import { ALLOWED_ORIGINS } from '../../shared/middleware/security.js'
import { autoJoinRooms, isStaff } from './rooms.js'

const log = createLogger('realtime')

export interface SocketData {
  claims: AccessTokenClaims
  namespace: 'storefront' | 'admin'
}

let io: Server | undefined

/** Sockets per user, so one runaway client cannot exhaust the server (§11.6). */
const connectionsPerUser = new Map<string, number>()

function extractToken(socket: Socket): string | undefined {
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth

  const header = socket.handshake.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  return undefined
}

function attachNamespace(namespace: Namespace, kind: 'storefront' | 'admin'): void {
  namespace.use((socket, next) => {
    const token = extractToken(socket)
    if (!token) {
      next(new Error('UNAUTHORIZED'))
      return
    }

    try {
      const claims = verifyAccessToken(token)

      if (kind === 'admin' && !isStaff(claims.roles)) {
        log.warn({ userId: claims.sub }, 'non-staff socket refused on the admin namespace')
        next(new Error('FORBIDDEN'))
        return
      }

      const current = connectionsPerUser.get(claims.sub) ?? 0
      if (current >= env.SOCKET_MAX_CONNECTIONS_PER_USER) {
        next(new Error('TOO_MANY_CONNECTIONS'))
        return
      }

      ;(socket.data as SocketData) = { claims, namespace: kind }
      next()
    } catch (error) {
      log.debug({ err: error }, 'socket handshake rejected')
      next(new Error('UNAUTHORIZED'))
    }
  })

  namespace.on('connection', (socket) => {
    const { claims } = socket.data as SocketData
    connectionsPerUser.set(claims.sub, (connectionsPerUser.get(claims.sub) ?? 0) + 1)

    const rooms = autoJoinRooms(kind, claims)
    for (const room of rooms) void socket.join(room)

    const payload: ConnectedPayload = {
      userId: claims.sub,
      rooms,
      serverTime: new Date().toISOString(),
    }
    socket.emit(REALTIME_EVENTS.CONNECTED, payload)
    log.debug({ userId: claims.sub, namespace: kind, rooms }, 'socket connected')

    // Re-verify on token refresh so a socket outlives a 15-minute access token
    // without ever holding an unverified identity.
    socket.on(CLIENT_EVENTS.REFRESH_AUTH, (token: unknown) => {
      if (typeof token !== 'string') return
      try {
        const refreshed = verifyAccessToken(token)
        if (refreshed.sub !== claims.sub) {
          socket.disconnect(true)
          return
        }
        ;(socket.data as SocketData).claims = refreshed
      } catch {
        socket.disconnect(true)
      }
    })

    // The one client-initiated join. Order-level authorisation lands with the
    // orders feature (Phase 6); until then no order rooms exist to join.
    socket.on(CLIENT_EVENTS.SUBSCRIBE_ORDER, () => {
      socket.emit('error', {
        code: 'NOT_AVAILABLE',
        message: 'Order subscriptions are not enabled yet',
      })
    })

    socket.on('disconnect', (reason) => {
      const remaining = (connectionsPerUser.get(claims.sub) ?? 1) - 1
      if (remaining <= 0) connectionsPerUser.delete(claims.sub)
      else connectionsPerUser.set(claims.sub, remaining)
      log.debug({ userId: claims.sub, reason }, 'socket disconnected')
    })
  })
}

export function initRealtime(httpServer: HttpServer): Server {
  if (io) return io

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: [...ALLOWED_ORIGINS], credentials: true },
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Single node today. A second instance needs an adapter and nothing else
    // (§11.7): @socket.io/postgres-adapter uses the direct connection.
    transports: ['websocket', 'polling'],
  })

  attachNamespace(io.of('/storefront'), 'storefront')
  attachNamespace(io.of('/admin'), 'admin')

  log.info('realtime server initialised')
  return io
}

export function getRealtime(): Server | undefined {
  return io
}

export async function closeRealtime(): Promise<void> {
  if (!io) return
  const closing = io
  io = undefined
  closing.of('/storefront').emit(REALTIME_EVENTS.SERVER_SHUTDOWN, {})
  closing.of('/admin').emit(REALTIME_EVENTS.SERVER_SHUTDOWN, {})
  await closing.close()
  connectionsPerUser.clear()
  log.info('realtime server closed')
}
