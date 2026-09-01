import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'

/**
 * The three states every fetched screen has.
 *
 * Written once so that a failure is never a blank page. The retry is offered
 * because most failures here are a dropped connection, and asking the shopper
 * to reload the whole page to recover from one is a poor apology.
 */
export function QueryBoundary({ isLoading, error, onRetry, fallback, children }) {
  if (isLoading) return fallback ?? null

  if (error) {
    return (
      <div className="border-line bg-surface flex flex-col items-center gap-3 rounded-card border px-6 py-12 text-center">
        <AlertCircle className="text-bad size-6" aria-hidden="true" />
        <p className="text-ink font-medium">That did not load</p>
        <p className="text-muted max-w-sm text-sm">{messageOf(error)}</p>
        {onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    )
  }

  return children
}
