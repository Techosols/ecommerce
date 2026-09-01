import { useEffect, type ReactNode } from 'react'
import { tokenStore } from '@/lib/api/tokenStore'
import { useAuth } from '@/features/auth/useAuth'
import { connectRealtime, disconnectRealtime, refreshRealtimeAuth } from './socket'

/**
 * Owns the socket's lifecycle against the session's.
 *
 * Connect when a staff session exists, disconnect when it ends, and hand the
 * socket every new access token as the HTTP client rotates it. Nothing else in
 * the application opens or closes the connection.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth()

  useEffect(() => {
    if (status !== 'authenticated') {
      disconnectRealtime()
      return
    }

    connectRealtime()

    // The HTTP client rotates the access token in the background; the live
    // socket has to be told, or it keeps identifying itself with an expired one.
    const unsubscribe = tokenStore.subscribe((token) => {
      if (token) refreshRealtimeAuth(token)
      else disconnectRealtime()
    })

    return () => {
      unsubscribe()
    }
  }, [status])

  // The socket is a module singleton, so unmounting the provider (a full
  // sign-out, or hot reload) must tear it down or the next mount finds a
  // connection carrying a dead token.
  useEffect(() => disconnectRealtime, [])

  return <>{children}</>
}
