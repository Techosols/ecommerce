import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { refreshAccessToken, tokens } from '@/lib/api'
import { cartKey } from '@/features/cart/hooks/cart.hooks'
import { accountApi } from './api/account.api'
import { AuthContext } from './auth.context'

/**
 * Who is signed in.
 *
 * A reload wipes the access token by design, so on mount this asks the server
 * to mint a fresh one from the refresh cookie. Until that resolves the answer
 * is "we do not know yet" — which is a third state, distinct from signed out,
 * and the reason `isRestoring` exists. A page that treated "not yet known" as
 * "signed out" would bounce a signed-in customer to the login screen on every
 * refresh.
 */
export function AuthProvider({ children }) {
  const [customer, setCustomer] = useState(null)
  const [isRestoring, setIsRestoring] = useState(true)
  const queryClient = useQueryClient()

  useEffect(() => {
    let cancelled = false

    tokens.onSessionEnded(() => {
      setCustomer(null)
      queryClient.clear()
    })

    ;(async () => {
      try {
        // The shared single-flight refresh, never a POST of our own. The
        // refresh token rotates on every use and the server treats a second
        // use of a rotated one as theft — so two concurrent attempts do not
        // waste a request, they revoke the session. React runs this effect
        // twice in development, which is exactly that case.
        const accessToken = await refreshAccessToken()
        if (cancelled) return
        if (accessToken) {
          tokens.set(accessToken)
          setCustomer(await accountApi.me())
        }
      } catch {
        // No cookie, or it has expired. Being signed out is not an error.
      } finally {
        if (!cancelled) setIsRestoring(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [queryClient])

  const signIn = useCallback(
    async (email, password) => {
      const session = await accountApi.login(email, password)
      tokens.set(session.accessToken)
      const me = await accountApi.me()
      setCustomer(me)
      // Signing in claims whatever was in the guest basket, so the cart is
      // re-read rather than assumed unchanged.
      await queryClient.invalidateQueries({ queryKey: cartKey })
      return me
    },
    [queryClient],
  )

  const register = useCallback(
    async (body) => {
      const session = await accountApi.register(body)
      // Registration signs you in, so the shape is the same as login.
      if (session?.accessToken) {
        tokens.set(session.accessToken)
        setCustomer(await accountApi.me())
        await queryClient.invalidateQueries({ queryKey: cartKey })
      }
      return session
    },
    [queryClient],
  )

  const signOut = useCallback(async () => {
    try {
      await accountApi.logout()
    } catch {
      // Whatever the server says, this browser is done with the session.
    }
    tokens.clear()
    setCustomer(null)
    queryClient.clear()
  }, [queryClient])

  const value = useMemo(
    () => ({ customer, isRestoring, isSignedIn: customer !== null, signIn, register, signOut }),
    [customer, isRestoring, signIn, register, signOut],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
