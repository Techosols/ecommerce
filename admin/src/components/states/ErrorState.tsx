import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { isNetworkError, isApiError, messageOf } from '@/lib/api/errors'
import { StatePanel } from './StatePanel'

export interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  title?: string
  variant?: 'inline' | 'page'
  className?: string
}

/**
 * Something went wrong, said in a way an operator can act on.
 *
 * The `requestId` is shown when the server sent one. It is the only string that
 * connects what a person saw to the line in the server's logs, and asking them
 * to reproduce the fault instead is how support tickets take a week.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  variant = 'inline',
  className,
}: ErrorStateProps) {
  const offline = isNetworkError(error)
  const requestId = isApiError(error) ? error.requestId : undefined

  return (
    <StatePanel
      tone="danger"
      icon={offline ? <WifiOff className="size-5" /> : <AlertTriangle className="size-5" />}
      title={title ?? (offline ? 'Cannot reach the server' : 'Something went wrong')}
      description={
        <>
          {messageOf(error)}
          {requestId ? (
            <span className="text-faint mt-2 block font-mono text-xs">Reference: {requestId}</span>
          ) : null}
        </>
      }
      actions={
        onRetry ? (
          <Button
            variant="secondary"
            onClick={onRetry}
            leadingIcon={<RefreshCw className="size-4" />}
          >
            Try again
          </Button>
        ) : undefined
      }
      variant={variant}
      {...(className !== undefined ? { className } : {})}
    />
  )
}
