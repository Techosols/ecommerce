import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { LoadingState } from '@/components/states/LoadingState'
import { ForbiddenState } from '@/components/states/AccessStates'
import { useAuth } from '@/features/auth/useAuth'
import type { Permission } from '@/features/auth/auth.types'

export interface ProtectedRouteProps {
  /** Hides the route from operators who lack it — the server refuses it too. */
  permission?: Permission
}

/**
 * The gate in front of every admin route.
 *
 * Three states, in this order:
 *
 *   restoring     the refresh cookie is still being exchanged — render nothing
 *                 conclusive, because redirecting here bounces every reload
 *                 through the login page
 *   anonymous     go to `/login`, remembering where they were headed
 *   authenticated render, subject to the route's permission
 *
 * The permission check is UX. It stops an operator navigating into a page whose
 * every request would 403, which is a confusing way to learn you lack access.
 * The refusal that matters happens on the server.
 */
export function ProtectedRoute({ permission }: ProtectedRouteProps) {
  const { status, can } = useAuth()
  const location = useLocation()

  if (status === 'restoring') return <LoadingState variant="page" label="Restoring your session…" />

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (permission && !can(permission)) return <ForbiddenState variant="page" />

  return <Outlet />
}

/** The mirror image: keeps a signed-in operator out of the login page. */
export function PublicOnlyRoute() {
  const { status } = useAuth()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from

  if (status === 'restoring') return <LoadingState variant="page" label="Checking your session…" />
  if (status === 'authenticated') return <Navigate to={from ?? '/dashboard'} replace />

  return <Outlet />
}
