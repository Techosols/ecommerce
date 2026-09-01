import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  getConnectionState,
  getSocket,
  subscribeToConnectionState,
  type ConnectionState,
} from './socket'
import type { RealtimeEvent } from './events'

/** The connection's state, for the status indicator in the header. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribeToConnectionState, getConnectionState, () => 'idle')
}

/**
 * Subscribes to one server event for as long as the component is mounted.
 *
 * Two details that are easy to get wrong:
 *
 *   • The handler lives in a ref, so an inline arrow function does not
 *     re-register the listener on every render — the classic way a component
 *     ends up handling the same event four times.
 *
 *   • The effect depends on the connection state. Child effects run before
 *     their parent's, so on first mount the socket does not exist yet;
 *     re-running when the connection opens is what makes the subscription
 *     attach at all, and it re-attaches after a reconnect.
 *
 * Only names in `REALTIME_EVENTS` type-check, which rules out subscribing to an
 * event the server never emits.
 */
export function useRealtimeEvent<TPayload>(
  event: RealtimeEvent,
  handler: (payload: TPayload) => void,
  enabled = true,
): void {
  const handlerRef = useRef(handler)
  const connectionState = useConnectionState()

  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    if (!enabled) return
    const socket = getSocket()
    if (!socket) return

    const listener = (payload: TPayload) => handlerRef.current(payload)
    socket.on(event, listener)
    return () => {
      socket.off(event, listener)
    }
  }, [event, enabled, connectionState])
}
