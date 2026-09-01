import type { ReactNode } from 'react'
import { isAuthError, isForbiddenError } from '@/lib/api/errors'
import { ForbiddenState, UnauthorizedState } from './AccessStates'
import { ErrorState } from './ErrorState'
import { LoadingState } from './LoadingState'

export interface QueryBoundaryProps {
  isLoading: boolean
  error: unknown
  onRetry?: () => void
  /** Rendered instead of the default spinner — pass a matching skeleton. */
  loadingFallback?: ReactNode
  variant?: 'inline' | 'page'
  children: ReactNode
}

/**
 * One place that turns a query's `{ isLoading, error }` into the right screen.
 *
 * Written as a component rather than a hook so that the order is fixed:
 * authentication first, then authorization, then the generic error, then the
 * content. Every page that hand-rolls this gets that order subtly wrong
 * somewhere and shows "something went wrong" for an expired session.
 */
export function QueryBoundary({
  isLoading,
  error,
  onRetry,
  loadingFallback,
  variant = 'inline',
  children,
}: QueryBoundaryProps) {
  if (isLoading) return <>{loadingFallback ?? <LoadingState variant={variant} />}</>
  if (isAuthError(error)) return <UnauthorizedState variant={variant} />
  if (isForbiddenError(error)) return <ForbiddenState variant={variant} />
  if (error) return <ErrorState error={error} variant={variant} {...(onRetry ? { onRetry } : {})} />
  return <>{children}</>
}
