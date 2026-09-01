import { Link, useSearchParams } from 'react-router-dom'
import { Receipt } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Pagination } from '@/components/ui/Pagination'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatMoney } from '@/lib/format'
import { useAuth } from '../useAuth'
import { useMyOrders } from '../hooks/account.hooks'

const STATUS = {
  pending: { label: 'Placed', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  processing: { label: 'Being prepared', tone: 'good' },
  shipped: { label: 'On its way', tone: 'good' },
  delivered: { label: 'Delivered', tone: 'good' },
  completed: { label: 'Complete', tone: 'good' },
  returned: { label: 'Returned', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
}

/**
 * Everything this account has bought, newest first.
 *
 * The signed-in guard and the "signed in as…" header live in `AccountLayout`,
 * which wraps every screen under `/account` — so this page is only ever
 * rendered for somebody who is signed in, and does not repeat the three-way
 * restoring / in / out decision that is easy to get subtly wrong.
 */
export function MyOrdersPage() {
  const { isSignedIn } = useAuth()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') ?? '1')
  const query = useMyOrders({ page, limit: 10 }, isSignedIn)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl">Orders</h2>
        <p className="text-muted text-sm">Everything you have bought, newest first.</p>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="h-40 w-full" />}
      >
        {(query.data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-6" />}
            title="No orders yet"
            description="Anything you buy will appear here."
            actions={
              <Link
                to="/products"
                className="bg-brand-600 hover:bg-brand-700 inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white"
              >
                Browse the shop
              </Link>
            }
          />
        ) : (
          <>
            <ul className="border-line bg-surface rounded-card divide-line divide-y border">
              {query.data.items.map((order) => {
                const status = STATUS[order.status] ?? { label: order.status, tone: 'neutral' }
                return (
                  <li key={order.id}>
                    <Link
                      to={`/account/orders/${order.id}`}
                      className="hover:bg-sunken flex items-center gap-4 px-5 py-4 transition-colors"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="text-ink tabular block font-medium">
                          {order.orderNumber}
                        </span>
                        <span className="text-muted block text-sm">
                          {new Date(order.placedAt).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          })}
                        </span>
                      </span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-ink tabular w-20 shrink-0 text-right font-medium">
                        {formatMoney(order.total)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
            <Pagination
              pagination={query.data?.pagination}
              onPageChange={(next) => {
                const updated = new URLSearchParams(params)
                updated.set('page', String(next))
                setParams(updated)
              }}
            />
          </>
        )}
      </QueryBoundary>
    </div>
  )
}
