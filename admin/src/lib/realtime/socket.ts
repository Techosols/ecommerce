import { io, type Socket } from 'socket.io-client'
import { env, SOCKET_NAMESPACE_URL } from '@/app/env'
import { tokenStore } from '@/lib/api/tokenStore'
import { CLIENT_EVENTS } from './events'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/**
 * One socket for the whole application.
 *
 * A module-level singleton rather than a socket per component: the server caps
 * connections per user (`SOCKET_MAX_CONNECTIONS_PER_USER`), and a hook that
 * opened its own would exhaust that cap with three panels on one page.
 * Components subscribe to events; they never open a connection.
 *
 * ## The handshake
 *
 * The access token goes in `handshake.auth.token`, which is what the server's
 * namespace middleware reads. It verifies the token, refuses a non-staff
 * account on `/admin` outright, and derives the rooms itself — the client
 * cannot ask for a room and does not try.
 *
 * ## Living longer than a token
 *
 * Access tokens expire in fifteen minutes; a socket held open all day would
 * otherwise be carrying claims the server verified hours ago. On every token
 * rotation the client emits `auth:refresh` with the new token and the server
 * re-verifies in place, disconnecting if the subject changed. This is why the
 * connection survives a refresh without a reconnect storm.
 */

let socket: Socket | null = null
let state: ConnectionState = 'idle'

type StateListener = (state: ConnectionState) => void
const stateListeners = new Set<StateListener>()

function setState(next: ConnectionState): void {
  if (state === next) return
  state = next
  for (const listener of stateListeners) listener(next)
}

export function getConnectionState(): ConnectionState {
  return state
}

export function subscribeToConnectionState(listener: StateListener): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function getSocket(): Socket | null {
  return socket
}

/** Opens the connection, or re-authenticates the existing one. */
export function connectRealtime(): Socket | null {
  const token = tokenStore.get()
  if (!token) return null

  if (socket) {
    // Already open: hand it the current token rather than reconnecting.
    socket.emit(CLIENT_EVENTS.REFRESH_AUTH, token)
    if (!socket.connected) socket.connect()
    return socket
  }

  setState('connecting')

  socket = io(SOCKET_NAMESPACE_URL, {
    path: env.socketPath,
    transports: ['websocket', 'polling'],
    auth: { token },
    withCredentials: true,
    // Realtime is a convenience layered over REST, so a failure to connect must
    // never block the admin. It backs off and keeps trying quietly.
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15_000,
    timeout: 10_000,
    autoConnect: true,
  })

  socket.on('connect', () => setState('connected'))
  socket.on('disconnect', () => setState('reconnecting'))
  socket.io.on('reconnect_attempt', () => {
    setState('reconnecting')
    // The token may have rotated while the socket was down; a reconnect that
    // replays the old one would be rejected as UNAUTHORIZED.
    const current = tokenStore.get()
    if (socket && current) socket.auth = { token: current }
  })

  socket.on('connect_error', (error: Error) => {
    // FORBIDDEN and UNAUTHORIZED are terminal — retrying with the same token
    // cannot succeed, and the HTTP layer will notice the session is gone.
    if (error.message === 'FORBIDDEN' || error.message === 'UNAUTHORIZED') {
      setState('failed')
      socket?.disconnect()
      return
    }
    setState('reconnecting')
  })

  return socket
}

/** Re-authenticates a live socket after the access token rotates. */
export function refreshRealtimeAuth(token: string): void {
  if (!socket) return
  socket.auth = { token }
  if (socket.connected) socket.emit(CLIENT_EVENTS.REFRESH_AUTH, token)
}

export function disconnectRealtime(): void {
  if (!socket) return
  socket.removeAllListeners()
  socket.disconnect()
  socket = null
  setState('idle')
}
