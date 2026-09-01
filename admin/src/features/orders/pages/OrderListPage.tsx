import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ShoppingCart } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useOrders } from '../hooks/orders.hooks'
import { OrderFilters } from '../components/OrderFilters.tsx'
import { emptyOrderFilters, type OrderFiltersValue } from '../components/orderFilters'
import {
  FulfillmentStatusBadge,
  OrderStatusBadge,
  PaymentStatusBadge,
} from '../components/OrderStatusBadges'
import type {
  FulfillmentStatus,
  OrderStatus,
  OrderSummary,
  PaymentStatus,
} from '../types/orders.types'

/**
 * The daily queue.
 *
 * Every narrowing happens on the server — search, the three status filters, the
 * tag filter and the page are query parameters, and one page of rows is all
 * that is ever in the browser. Filtering an array held locally stops being true
 * the moment a shop has more orders than fit on a page, which is immediately.
 *
 * Filter state lives in the URL, so "everything paid and unshipped" is a link
 * somebody can bookmark or send to a colleague.
 *
 * There is no sort control: `orderListQuery` accepts no sort parameter, and the
 * server returns newest first — which is the order this list is read in anyway.
 * Offering a column header that quietly did nothing would be worse than not
 * offering one.
 */
export function OrderListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  useDocumentTitle('Orders')

  const page = Number(params.get('page') ?? '1')
  const limit = Number(params.get('limit') ?? '20')
  const tags = params.getAll('tags')

  const [filters, setFiltersState] = useState<OrderFiltersValue>(() => ({
    q: params.get('q') ?? '',
    status: (params.get('status') ?? '') as OrderStatus | '',
    paymentStatus: (params.get('paymentStatus') ?? '') as PaymentStatus | '',
    fulfillmentStatus: (params.get('fulfillmentStatus') ?? '') as FulfillmentStatus | '',
  }))

  // The input stays instant; only the request waits.
  const debouncedQuery = useDebouncedValue(filters.q, 300)

  function setFilters(next: OrderFiltersValue) {
    setFiltersState(next)
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        const entries = Object.entries(next) as Array<[keyof OrderFiltersValue, string]>
        for (const [key, value] of entries) {
          if (value) search.set(key, value)
          else search.delete(key)
        }
        // A narrower filter almost never has the page the operator was on.
        search.delete('page')
        return search
      },
      { replace: true },
    )
  }

  function clearTag(tag: string) {
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        const kept = search.getAll('tags').filter((value) => value !== tag)
        search.delete('tags')
        for (const value of kept) search.append('tags', value)
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

  const query = useOrders({
    page,
    limit,
    ...(debouncedQuery ? { q: debouncedQuery } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.fulfillmentStatus ? { fulfillmentStatus: filters.fulfillmentStatus } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  })

  const isFiltered =
    Boolean(debouncedQuery) ||
    filters.status !== '' ||
    filters.paymentStatus !== '' ||
    filters.fulfillmentStatus !== '' ||
    tags.length > 0

  const columns = useMemo<Array<Column<OrderSummary>>>(
    () => [
      {
        id: 'order',
        header: 'Order',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block font-medium">{row.orderNumber}</span>
            <span className="text-faint block truncate text-xs">{row.email}</span>
          </div>
        ),
      },
      {
        id: 'placed',
        header: 'Placed',
        hideBelow: 'md',
        cell: (row) => <span className="text-muted text-xs">{formatDateTime(row.placedAt)}</span>,
      },
      {
        id: 'total',
        header: 'Total',
        align: 'right',
        cell: (row) => (
          <div>
            <span className="text-ink tabular font-medium">{formatMoney(row.total)}</span>
            {/* Only when money has actually gone back, and always as a
                subtraction — a refunded order whose row shows only the gross
                reads as revenue the shop still has. */}
            {row.refundedTotal.amount > 0 ? (
              <span className="text-danger tabular block text-xs">
                −{formatMoney(row.refundedTotal)} refunded
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '9rem',
        cell: (row) => <OrderStatusBadge status={row.status} size="sm" />,
      },
      {
        id: 'payment',
        header: 'Payment',
        width: '9rem',
        hideBelow: 'sm',
        cell: (row) => <PaymentStatusBadge status={row.paymentStatus} size="sm" />,
      },
      {
        id: 'fulfillment',
        header: 'Fulfilment',
        width: '9rem',
        hideBelow: 'lg',
        cell: (row) =>
          row.status === 'cancelled' ? (
            <span className="text-faint text-xs">—</span>
          ) : (
            <FulfillmentStatusBadge status={row.fulfillmentStatus} size="sm" />
          ),
      },
      {
        id: 'tags',
        header: 'Tags',
        hideBelow: 'lg',
        cell: (row) =>
          row.tags.length === 0 ? (
            <span className="text-faint">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.tags.slice(0, 2).map((tag) => (
                <Badge key={tag} size="sm">
                  {tag}
                </Badge>
              ))}
              {row.tags.length > 2 ? (
                <Badge size="sm" tone="neutral">
                  +{row.tags.length - 2}
                </Badge>
              ) : null}
            </div>
          ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Orders"
        description="What came in, what is paid, and what still has to go out."
      />

      <Card>
        <div className="border-line flex flex-col gap-3 border-b px-4 py-3 sm:px-5">
          <OrderFilters value={filters} onChange={setFilters} />

          {tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted text-xs">Tagged</span>
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => clearTag(tag)}
                  aria-label={`Remove the ${tag} tag filter`}
                  className="border-line-strong text-ink-soft hover:bg-surface-hover rounded-md border px-2 py-0.5 text-xs"
                >
                  {tag} ×
                </button>
              ))}
            </div>
          ) : null}
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
            caption="Orders"
            isLoading={query.isFetching && !query.data}
            onRowClick={(row) => void navigate(`/orders/${row.id}`)}
            emptyState={
              isFiltered ? (
                <EmptyState
                  icon={<ShoppingCart className="size-5" />}
                  title="No orders match these filters"
                  description="Try a different search, or clear the filters to see everything."
                  actions={
                    <Button variant="secondary" onClick={() => setFilters(emptyOrderFilters)}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<ShoppingCart className="size-5" />}
                  title="No orders yet"
                  description="Orders placed on the storefront appear here as they come in."
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
