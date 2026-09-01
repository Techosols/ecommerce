import { Link } from 'react-router-dom'
import { PackageCheck } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '../useAuth'
import { useMyReturns } from '../hooks/returns.hooks'
import { RETURN_REASONS, RETURN_STATUS } from '../returnVocabulary'

/**
 * Returns this customer has opened.
 *
 * A return is started from the order it belongs to, not from here — which is
 * why this page has no "new return" button and points at the orders list
 * instead. Starting one needs to know what was bought and how much of it has
 * already gone back, and only the order knows that.
 */
export function ReturnsPage() {
  const { isSignedIn } = useAuth()
  const query = useMyReturns({ page: 1, limit: 20 }, isSignedIn)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl">Returns</h2>
        <p className="text-muted text-sm">
          Anything you have sent back, and where it has got to.
        </p>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="h-40 w-full" />}
      >
        {(query.data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={<PackageCheck className="size-6" />}
            title="No returns"
            description="Nothing sent back so far. You can start one from any order that has been dispatched."
            actions={
              <Link
                to="/account/orders"
                className="bg-brand-600 hover:bg-brand-700 inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white"
              >
                See your orders
              </Link>
            }
          />
        ) : (
          <ul className="border-line bg-surface rounded-card divide-line divide-y border">
            {query.data.items.map((request) => {
              const status = RETURN_STATUS[request.status] ?? {
                label: request.status,
                tone: 'neutral',
              }
              return (
                <li key={request.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink tabular text-sm font-medium">
                      {request.returnNumber}
                    </p>
                    <p className="text-muted text-sm">
                      {RETURN_REASONS[request.reason] ?? request.reason} ·{' '}
                      {new Date(request.requestedAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                  </div>

                  {request.refunded ? <Badge tone="good">Refunded</Badge> : null}
                  <Badge tone={status.tone}>{status.label}</Badge>

                  <Link
                    to={`/account/orders/${request.orderId}`}
                    className="text-brand-600 text-sm hover:underline"
                  >
                    The order
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </QueryBoundary>
    </div>
  )
}
