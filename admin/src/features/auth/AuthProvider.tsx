import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setSessionExpiredHandler } from '@/lib/api/client'
import { tokenStore } from '@/lib/api/tokenStore'
import { ApiError, isAuthError } from '@/lib/api/errors'
import { API_BASE_URL } from '@/app/env'
import { authApi } from './auth.api'
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth.context'
import type { CurrentUser, LoginInput } from './auth.types'

type RestoreResult =
  { outcome: 'staff'; user: CurrentUser } | { outcome: 'anonymous' } | { outcome: 'not-staff' }

/**
 * Exchanges the refresh cookie for a session, once.
 *
 * Outside the component so it holds no React state and can be shared by both
 * of StrictMode's mounts. It sets the access token as a side effect — the HTTP
 * client needs it before `/auth/me` is called — and reports what it found.
 */
async function restoreSession(): Promise<RestoreResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) return { outcome: 'anonymous' }

    const body = (await response.json()) as { data?: { accessToken?: string } }
    const accessToken = body.data?.accessToken
    if (!accessToken) return { outcome: 'anonymous' }

    tokenStore.set(accessToken)
    const user = await authApi.me()

    if (!user.isStaff) {
      // A customer's cookie is a valid session for the storefront and no use
      // here. End it rather than leaving a signed-in-but-refused state.
      await authApi.logout().catch(() => undefined)
      return { outcome: 'not-staff' }
    }

    return { outcome: 'staff', user }
  } catch {
    return { outcome: 'anonymous' }
  }
}

/**
 * The admin's authentication state.
 *
 * There is exactly one mechanism here, and it is the server's: a short-lived
 * access token held in memory, and a long-lived refresh token in an httpOnly
 * cookie the browser sends only to `/api/v1/auth`. Nothing is invented on this
 * side — no separate admin login, no parallel token, no persisted session.
 *
 * ## Restoring a session on reload
 *
 * A page refresh wipes the in-memory access token, which is the point: the
 * cookie is the durable half. On mount the provider posts `/auth/refresh`
 * once. If the cookie is still good a new access token comes back and
 * `/auth/me` returns the operator; if it is not, the admin is simply anonymous
 * and the route guard sends them to `/login`. Until that round trip finishes
 * the status is `restoring`, and no protected route may redirect — otherwise
 * every reload bounces the operator to the login page for a moment before
 * bouncing them back.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<AuthStatus>('restoring')
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [endedReason, setEndedReason] = useState<AuthContextValue['endedReason']>(null)

  const clearSession = useCallback(
    (reason: AuthContextValue['endedReason']) => {
      tokenStore.clear()
      setUser(null)
      setStatus('anonymous')
      setEndedReason(reason)
      // Cached server state belongs to the account that fetched it. Leaving it
      // behind would show the previous operator's data to the next one.
      queryClient.clear()
    },
    [queryClient],
  )

  // The HTTP client cannot reach React state, so it reports an unrecoverable
  // 401 back through this handler.
  useEffect(() => {
    setSessionExpiredHandler(() => clearSession('expired'))
  }, [clearSession])

  const restoreRef = useRef<Promise<RestoreResult> | null>(null)

  useEffect(() => {
    let cancelled = false

    // The request runs exactly once, but every mount reads its result.
    //
    // Both halves matter. StrictMode mounts effects twice in development, and
    // two refreshes would rotate the token underneath each other and trip the
    // server's reuse detection, revoking a perfectly good session — hence the
    // shared promise. But guarding the *effect* instead would leave the second
    // mount, the one that is actually alive, with nothing to apply, and the
    // admin would sit on "Restoring your session…" for ever.
    restoreRef.current ??= restoreSession()

    void restoreRef.current.then((result) => {
      if (cancelled) return

      if (result.outcome === 'staff') {
        setUser(result.user)
        setStatus('authenticated')
        setEndedReason(null)
        return
      }

      tokenStore.clear()
      setUser(null)
      setStatus('anonymous')
      setEndedReason(result.outcome === 'not-staff' ? 'not-staff' : null)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(
    async (input: LoginInput) => {
      const result = await authApi.login(input)

      // `/auth/login` is shared with the storefront, so a customer's
      // credentials are valid here. Staff is the gate for this application —
      // and the server enforces it again on every `/admin` request.
      if (!result.user.isStaff) {
        await authApi.logout().catch(() => undefined)
        throw new ApiError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'This account does not have access to the admin.',
        })
      }

      tokenStore.set(result.accessToken)
      queryClient.clear()
      setUser(result.user)
      setStatus('authenticated')
      setEndedReason(null)
      return result.user
    },
    [queryClient],
  )

  const logout = useCallback(async () => {
    // The server revokes the session and clears the cookie. A failure here
    // still ends the session locally: leaving an operator signed in because a
    // request failed is the worse outcome.
    await authApi.logout().catch(() => undefined)
    clearSession('signed-out')
  }, [clearSession])

  const refreshUser = useCallback(async () => {
    try {
      const me = await authApi.me()
      if (!me.isStaff) {
        clearSession('not-staff')
        return
      }
      setUser(me)
    } catch (error) {
      if (isAuthError(error)) clearSession('expired')
    }
  }, [clearSession])

  const value = useMemo<AuthContextValue>(() => {
    const granted = new Set(user?.permissions ?? [])
    const roles = new Set(user?.roles ?? [])

    return {
      status,
      user,
      endedReason,
      login,
      logout,
      refreshUser,
      // Rendering decisions only. The server has already decided what it will
      // allow, and it decides again on every request.
      can: (permission) =>
        Array.isArray(permission)
          ? permission.every((item) => granted.has(item))
          : granted.has(permission),
      canAny: (permissions) => permissions.some((item) => granted.has(item)),
      hasRole: (role) => roles.has(role),
    }
  }, [status, user, endedReason, login, logout, refreshUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
