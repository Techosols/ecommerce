import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ShoppingBag } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { StatCard } from '@/components/ui/StatCard'
import { DataTable, type Column } from '@/components/ui/Table'
import { Tooltip } from '@/components/ui/Tooltip'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { idleFor } from '../components/failureLabels'
import { useCarts } from '../hooks/checkout.hooks'
import type { CartStatus, CartSummary } from '../types/checkout.types'
import type { Money } from '@/types/api'

const STATUS_LABELS: Record<CartStatus, string> = {
  active: 'Still open',
  abandoned: 'Left',
  converted: 'Bought',
}

/**
 * What people put down and did not buy.
 *
 * The value column is the reason this screen exists, and it is worth being
 * precise about what it means: a cart stores references and quantities, never
 * prices, so this is what those items cost **today**. That is the right number
 * — it is what recovering the basket would be worth now — and it moves when
 * the catalogue moves.
 *
 * Empty carts are hidden by default. One is created by anybody who so much as
 * looks at the shop, and a list dominated by them answers nothing.
 */
export function CartListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  useDocumentTitle('Baskets')

  const page = Number(params.get('page') ?? '1')
  const status = params.get('status') ?? 'abandoned'
  const [search, setSearch] = useState(params.get('q') ?? '')
  const debounced = useDebouncedValue(search, 300)

  function set(key: string, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  const query = useCarts({
    page,
    limit: 20,
    ...(status ? { status: status as CartStatus } : {}),
    ...(debounced ? { q: debounced } : {}),
  })

  const abandonedValue = query.data?.meta?.abandonedValue as Money | undefined
  const abandonedCount = query.data?.meta?.abandonedCount as number | undefined

  const columns = useMemo<Array<Column<CartSummary>>>(
    () => [
      {
        id: 'shopper',
        header: 'Shopper',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">
              {row.customerName ?? row.customerEmail ?? 'A guest'}
            </span>
            <span className="text-faint block truncate text-xs">
              {row.customerEmail ?? 'No account — there is nobody to email'}
            </span>
          </div>
        ),
      },
      {
        id: 'items',
        header: 'Items',
        align: 'right',
        width: '6rem',
        cell: (row) => <span className="text-muted tabular">{formatNumber(row.itemCount)}</span>,
      },
      {
        id: 'value',
        header: 'Worth now',
        align: 'right',
        width: '9rem',
        cell: (row) => (
          <span className="text-ink tabular font-medium">{formatMoney(row.value)}</span>
        ),
      },
      {
        id: 'idle',
        header: 'Untouched for',
        width: '10rem',
        hideBelow: 'sm',
        cell: (row) => (
          <Tooltip label={formatDateTime(row.lastActivityAt)}>
            <span className="text-muted text-sm">{idleFor(row.lastActivityAt)}</span>
          </Tooltip>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '8rem',
        cell: (row) => (
          <Badge
            tone={
              row.status === 'converted' ? 'positive' : row.status === 'active' ? 'info' : 'neutral'
            }
          >
            {STATUS_LABELS[row.status]}
          </Badge>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      {abandonedValue && abandonedCount !== undefined ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard
            label="Left behind"
            value={formatNumber(abandonedCount)}
            hint="Baskets with something in them that nobody came back for"
          />
          <StatCard
            label="Worth"
            value={formatMoney(abandonedValue)}
            hint="At today's prices, across every abandoned basket"
          />
        </div>
      ) : null}

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={Boolean(debounced) || status !== 'abandoned'}
            onClear={() => {
              setSearch('')
              setParams(new URLSearchParams(), { replace: true })
            }}
            search={
              <SearchInput
                size="sm"
                aria-label="Search baskets"
                placeholder="Customer name or email…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  set('q', event.target.value)
                }}
                onClear={() => {
                  setSearch('')
                  set('q', '')
                }}
              />
            }
            filters={
              <Select
                size="sm"
                aria-label="Basket status"
                value={status}
                onChange={(event) => set('status', event.target.value)}
                options={[
                  { value: 'abandoned', label: 'Left behind' },
                  { value: 'active', label: 'Still open' },
                  { value: 'converted', label: 'Became an order' },
                  { value: '', label: 'Any status' },
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
            caption="Baskets"
            onRowClick={(row) => void navigate(`/checkout/carts/${row.id}`)}
            emptyState={
              <EmptyState
                icon={<ShoppingBag className="size-5" />}
                title={
                  status === 'abandoned' ? 'Nothing has been left behind' : 'No baskets here'
                }
                description={
                  status === 'abandoned'
                    ? 'A basket is counted as left once nobody has touched it since it expired. Empty ones are never listed.'
                    : 'Try a different status, or clear the filters.'
                }
                actions={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearch('')
                      setParams(new URLSearchParams(), { replace: true })
                    }}
                  >
                    Clear filters
                  </Button>
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
