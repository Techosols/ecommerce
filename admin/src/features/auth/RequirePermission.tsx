import type { ReactNode } from 'react'
import { ForbiddenState } from '@/components/states/AccessStates'
import { useAuth } from './useAuth'
import type { Permission } from './auth.types'

export interface RequirePermissionProps {
  /** All of these must be held; use `anyOf` for "at least one". */
  permission?: Permission | Permission[]
  anyOf?: Permission[]
  /** What to show instead. Defaults to nothing — the feature simply is not there. */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Hides a control the operator cannot use.
 *
 * This is a UX affordance and nothing more. Rendering a Refund button for
 * somebody without `payments:refund` is a worse experience, not a security
 * hole — the hole would be the server trusting this decision, and it does not:
 * `requirePermission()` runs on every admin route regardless of what the
 * browser chose to draw.
 *
 * Defaulting to rendering nothing rather than a "no access" message is
 * deliberate. A toolbar full of explanations about buttons an operator will
 * never have is noise; a *page* they navigated to explicitly is different, and
 * that is what `ForbiddenSection` is for.
 */
export function RequirePermission({
  permission,
  anyOf,
  fallback = null,
  children,
}: RequirePermissionProps) {
  const { can, canAny } = useAuth()

  const allowed = (permission ? can(permission) : true) && (anyOf ? canAny(anyOf) : true)

  return <>{allowed ? children : fallback}</>
}

/** The page-level form: says why, rather than silently rendering nothing. */
export function ForbiddenSection({ resource }: { resource?: string }) {
  return <ForbiddenState variant="inline" {...(resource ? { resource } : {})} />
}
