import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Pagination } from '@/components/ui/Pagination'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useRedemptions } from '../hooks/discounts.hooks'
import type { Money } from '@/types/api'

export interface RedemptionsCardProps {
  discountId: string
}

/**
 * What the code has actually given away.
 *
 * `usageCount` says a code was used 47 times, which is not the question anyone
 * asks about a campaign — they ask what it cost. This reads the redemption
 * ledger, the same table the per-customer limit is counted from, so the total
 * here and the limit enforced at checkout cannot disagree.
 *
 * The total comes from the server rather than being summed here: adding up one
 * page of twenty rows and calling it the campaign's cost is exactly the bug
 * `meta.totalAmount` exists to prevent.
 */
export function RedemptionsCard({ discountId }: RedemptionsCardProps) {
  const [page, setPage] = useState(1)
  const query = useRedemptions(discountId, page)

  const totalAmount = query.data?.meta?.totalAmount as Money | undefined

  return (
    <Card>
      <CardHeader
        title="What it has given away"
        description="Every order that used this code, newest first."
        actions={
          totalAmount ? (
            <span className="text-ink tabular text-sm font-medium">
              {formatMoney(totalAmount)}
              <span className="text-faint ml-1 text-xs font-normal">
                across {query.data?.pagination.total ?? 0} orders
              </span>
            </span>
          ) : undefined
        }
      />
      <CardBody>
        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data && query.data.items.length > 0 ? (
            <ul className="divide-line divide-y">
              {query.data.items.map((redemption) => (
                <li key={redemption.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <Link
                      to={`/orders/${redemption.orderId}`}
                      className="text-ink hover:text-brand-600 block truncate text-sm font-medium"
                    >
                      {redemption.orderNumber ?? 'An order'}
                    </Link>
                    <span className="text-faint block truncate text-xs">
                      {/* A guest leaves an order and no account, which is a
                          real answer rather than a missing one. */}
                      {redemption.customerEmail ?? 'A guest'} ·{' '}
                      {formatDateTime(redemption.createdAt)}
                    </span>
                  </span>

                  <span className="text-ink tabular shrink-0 text-sm">
                    {formatMoney(redemption.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">Nobody has used this code yet.</p>
          )}

          {query.data && query.data.pagination.totalPages > 1 ? (
            <div className="border-line mt-3 border-t pt-3">
              <Pagination pagination={query.data.pagination} onPageChange={setPage} />
            </div>
          ) : null}
        </QueryBoundary>
      </CardBody>
    </Card>
  )
}
