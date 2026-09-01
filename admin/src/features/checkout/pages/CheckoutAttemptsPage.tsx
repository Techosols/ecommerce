import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, CircleSlash } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { Pagination } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { failureLabel, failureTone, successRate } from '../components/failureLabels'
import { useAttemptSummary, useCheckoutAttempts } from '../hooks/checkout.hooks'
import type { AttemptOutcome, CheckoutAttempt } from '../types/checkout.types'

/**
 * Every checkout the shop was asked for, and what came of it.
 *
 * Worth being clear about what this is *not*: a checkout session. Checkout is
 * one atomic request that either produces an order or refuses, and nothing
 * here is resumed or advanced. It is the record of which happened, written
 * after the fact, so a shop can see that forty people failed to buy this
 * morning and what stopped them.
 *
 * The reasons are grouped by the server's own error codes rather than by the
 * message a shopper saw, because the message is written for them and gets
 * reworded, while the code is the contract.
 */
export function CheckoutAttemptsPage() {
  const [params, setParams] = useSearchParams()
  useDocumentTitle('Checkout attempts')

  const page = Number(params.get('page') ?? '1')
  const outcome = params.get('outcome') ?? ''
  const failureCode = params.get('failureCode') ?? ''

  /**
   * Applies several filters at once.
   *
   * One call rather than one per key: two `setParams` in the same tick both
   * read the location as it was, so the second silently discards the first.
   */
  function set(patch: Record<string, string>) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  const summary = useAttemptSummary()
  const query = useCheckoutAttempts({
    page,
    limit: 25,
    ...(outcome ? { outcome: outcome as AttemptOutcome } : {}),
    ...(failureCode ? { failureCode } : {}),
  })

  const [reasonsOpen, setReasonsOpen] = useState(true)
  const isFiltered = outcome !== '' || failureCode !== ''

  const columns = useMemo<Array<Column<CheckoutAttempt>>>(
    () => [
      {
        id: 'outcome',
        header: 'Outcome',
        width: '14rem',
        cell: (row) =>
          row.outcome === 'placed' ? (
            <span className="text-positive flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="size-3.5" />
              {row.orderId ? (
                <Link to={`/orders/${row.orderId}`} className="hover:underline">
                  Bought
                </Link>
              ) : (
                'Bought'
              )}
            </span>
          ) : (
            <Badge tone={failureTone(row.failureCode)}>{failureLabel(row.failureCode)}</Badge>
          ),
      },
      {
        id: 'who',
        header: 'Shopper',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate text-sm">{row.email ?? 'A guest'}</span>
            {row.failureMessage ? (
              <span className="text-faint block truncate text-xs" title={row.failureMessage}>
                {row.failureMessage}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'basket',
        header: 'Basket',
        align: 'right',
        width: '9rem',
        hideBelow: 'sm',
        cell: (row) => (
          <div>
            <span className="text-ink tabular block text-sm">{formatMoney(row.subtotal)}</span>
            <span className="text-faint block text-xs">
              {formatNumber(row.itemCount)} {row.itemCount === 1 ? 'item' : 'items'}
            </span>
          </div>
        ),
      },
      {
        id: 'where',
        header: 'To',
        width: '6rem',
        hideBelow: 'md',
        cell: (row) => <span className="text-muted text-sm">{row.countryCode ?? '—'}</span>,
      },
      {
        id: 'when',
        header: 'When',
        width: '12rem',
        hideBelow: 'md',
        cell: (row) => (
          <span className="text-muted text-xs">{formatDateTime(row.createdAt)}</span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <QueryBoundary
        isLoading={summary.isPending}
        error={summary.error}
        onRetry={() => void summary.refetch()}
      >
        {summary.data ? (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Bought"
                value={formatNumber(summary.data.placed)}
                hint="Checkouts that became an order, last 7 days"
              />
              <StatCard
                label="Refused"
                value={formatNumber(summary.data.failed)}
                hint="Checkouts the shop turned away"
              />
              <StatCard
                label="Got through"
                value={successRate(summary.data.placed, summary.data.failed)}
                hint="Of every checkout tried"
              />
            </div>

            {summary.data.reasons.length > 0 ? (
              <Card>
                <CardHeader
                  title="What stopped them"
                  description="Grouped by the reason the server gave, last 7 days."
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setReasonsOpen((open) => !open)}
                    >
                      {reasonsOpen ? 'Hide' : 'Show'}
                    </Button>
                  }
                />
                {reasonsOpen ? (
                  <CardBody>
                    <ul className="flex flex-col gap-2">
                      {summary.data.reasons.map((reason) => {
                        const share = Math.round((reason.count / Math.max(summary.data.failed, 1)) * 100)
                        return (
                          <li key={reason.code} className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => set({ failureCode: reason.code, outcome: 'failed' })}
                              className="text-ink hover:text-brand-600 w-56 shrink-0 truncate text-left text-sm"
                            >
                              {failureLabel(reason.code)}
                            </button>
                            {/* A bar rather than a chart: one dimension, ten
                                rows, and the comparison is the whole point. */}
                            <span className="bg-surface-sunken h-2 min-w-0 flex-1 overflow-hidden rounded-full">
                              <span
                                className="bg-warning block h-full rounded-full"
                                style={{ width: `${Math.max(share, 2)}%` }}
                              />
                            </span>
                            <span className="text-muted tabular w-16 shrink-0 text-right text-sm">
                              {formatNumber(reason.count)}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </CardBody>
                ) : null}
              </Card>
            ) : null}
          </>
        ) : null}
      </QueryBoundary>

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={isFiltered}
            onClear={() => setParams(new URLSearchParams(), { replace: true })}
            filters={
              <>
                <Select
                  size="sm"
                  aria-label="Outcome"
                  value={outcome}
                  onChange={(event) => set({ outcome: event.target.value })}
                  options={[
                    { value: '', label: 'Everything' },
                    { value: 'placed', label: 'Bought' },
                    { value: 'failed', label: 'Refused' },
                  ]}
                />
                {failureCode ? (
                  <Button variant="ghost" size="sm" onClick={() => set({ failureCode: '' })}>
                    {failureLabel(failureCode)} ✕
                  </Button>
                ) : null}
              </>
            }
          />
        </div>

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            getRowId={(row) => row.id}
            caption="Checkout attempts"
            emptyState={
              <EmptyState
                icon={<CircleSlash className="size-5" />}
                title={isFiltered ? 'Nothing matches those filters' : 'No checkouts yet'}
                description={
                  isFiltered
                    ? 'Try a different outcome, or clear the filters.'
                    : 'Every checkout the shop is asked for is recorded here, whether it worked or not.'
                }
              />
            }
          />

          {query.data && query.data.items.length > 0 ? (
            <div className="border-line border-t px-4 py-3 sm:px-5">
              <Pagination
                pagination={query.data.pagination}
                onPageChange={(next) =>
                  setParams((current) => {
                    const search = new URLSearchParams(current)
                    search.set('page', String(next))
                    return search
                  })
                }
              />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>
    </div>
  )
}
