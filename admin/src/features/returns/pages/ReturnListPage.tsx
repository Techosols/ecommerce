import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PackageOpen } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDateTime } from '@/lib/format'
import { useReturns } from '../hooks/returns.hooks'
import { reasonLabels, statusTones } from '../components/returnLabels'
import type { ReturnStatus, ReturnSummary } from '../types/returns.types'

const statuses: ReturnStatus[] = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'closed',
  'declined',
  'cancelled',
]

/**
 * The returns queue.
 *
 * Paged and filtered on the server, with the status in the URL so "everything
 * still waiting to be approved" is a link. Sorted newest first by the endpoint,
 * which is the order a desk works through it.
 */
export function ReturnListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  useDocumentTitle('Returns')

  const page = Number(params.get('page') ?? '1')
  const limit = Number(params.get('limit') ?? '20')
  const status = (params.get('status') ?? '') as ReturnStatus | ''

  function setStatus(next: string) {
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        if (next) search.set('status', next)
        else search.delete('status')
        search.delete('page')
        return search
      },
      { replace: true },
    )
  }

  function setPage(next: number) {
    setParams((current) => {
      const search = new URLSearchParams(current)
      search.set('page', String(next))
      return search
    })
  }

  const query = useReturns({ page, limit, ...(status ? { status } : {}) })

  const columns = useMemo<Array<Column<ReturnSummary>>>(
    () => [
      {
        id: 'return',
        header: 'Return',
        cell: (row) => (
          <span className="text-ink font-medium">{row.returnNumber}</span>
        ),
      },
      {
        id: 'requested',
        header: 'Requested',
        hideBelow: 'md',
        cell: (row) => (
          <span className="text-muted text-xs">{formatDateTime(row.requestedAt)}</span>
        ),
      },
      {
        id: 'reason',
        header: 'Reason',
        hideBelow: 'sm',
        cell: (row) => <span className="text-ink-soft">{reasonLabels[row.reason]}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        width: '9rem',
        cell: (row) => {
          const { tone, label } = statusTones[row.status]
          return (
            <Badge tone={tone} size="sm">
              {label}
            </Badge>
          )
        },
      },
      {
        id: 'refunded',
        header: 'Refunded',
        align: 'right',
        hideBelow: 'lg',
        cell: (row) =>
          row.refunded ? (
            <Badge tone="positive" size="sm">
              Yes
            </Badge>
          ) : (
            <span className="text-faint text-xs">Not yet</span>
          ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Returns"
        description="Goods coming back. Approve them, record what arrives, and decide what goes back on the shelf."
      />

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={status !== ''}
            onClear={() => setStatus('')}
            filters={
              <Select
                size="sm"
                aria-label="Filter by status"
                className="w-40"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                options={[
                  { value: '', label: 'Any status' },
                  ...statuses.map((value) => ({ value, label: statusTones[value].label })),
                ]}
              />
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
            caption="Returns"
            isLoading={query.isFetching && !query.data}
            onRowClick={(row) => void navigate(`/returns/${row.id}`)}
            emptyState={
              status ? (
                <EmptyState
                  icon={<PackageOpen className="size-5" />}
                  title={`Nothing is ${statusTones[status].label.toLowerCase()}`}
                  description="Clear the filter to see the whole queue."
                  actions={
                    <Button variant="secondary" onClick={() => setStatus('')}>
                      Clear filter
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<PackageOpen className="size-5" />}
                  title="No returns"
                  description="Returns opened from an order appear here."
                />
              )
            }
          />

          {query.data && query.data.items.length > 0 ? (
            <div className="border-line border-t px-4 py-3 sm:px-5">
              <Pagination pagination={query.data.pagination} onPageChange={setPage} />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>
    </div>
  )
}
