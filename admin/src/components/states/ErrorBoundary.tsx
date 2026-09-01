import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { StatePanel } from './StatePanel'

interface Props {
  children: ReactNode
  /** Changing this resets the boundary — pass the pathname to clear on navigation. */
  resetKey?: string
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time crashes so one broken component does not blank the admin.
 *
 * It deliberately does not catch data-fetching failures: those are values a
 * query returns, handled by `QueryBoundary`, where they can be retried without
 * remounting the tree.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack)
  }

  private readonly reset = () => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <StatePanel
        tone="danger"
        variant="page"
        icon={<RefreshCw className="size-5" />}
        title="This page stopped working"
        description="The error has been logged. Reloading usually clears it."
        actions={
          <>
            <Button variant="secondary" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </>
        }
      />
    )
  }
}
