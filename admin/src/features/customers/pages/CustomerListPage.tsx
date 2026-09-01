import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Plus, RefreshCw, Users } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { DataTable, type Column } from '@/components/ui/Table'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDate, formatMoney } from '@/lib/format'
import { customersApi } from '../api/customers.api'
import { CustomerFilters } from '../components/CustomerFilters.tsx'
import { CustomerFormDialog } from '../components/CustomerFormDialog'
import {
  emptyCustomerFilters,
  isFiltered as computeIsFiltered,
  readFilters,
  toParams,
  type CustomerFiltersValue,
} from '../components/customerFilters'
import { MARKETING_LABELS, MARKETING_TONES, customerName } from '../components/customerLabels'
import { useCustomers, useRecomputeAllMetrics, useSegments } from '../hooks/customers.hooks'
import type { CustomerSummary } from '../types/customers.types'

/**
 * Everyone who has ever bought, or been entered by hand.
 *
 * Every narrowing happens on the server — search, the segment, the commercial
 * filters, the sort and the page are query parameters, and one page of rows is
 * all that is ever in the browser. Sorting an array held locally stops being
 * true the moment a shop has more customers than fit on a page.
 *
 * Filter state lives in the URL, so "everyone who spent over £500 and has not
 * ordered since June" is a link somebody can send to a colleague.
 */
export function CustomerListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Customers')

  const canWrite = can('customers:write')
  const page = Number(params.get('page') ?? '1')
  const limit = Number(params.get('limit') ?? '20')
  const tags = params.getAll('tags')

  const [filters, setFiltersState] = useState<CustomerFiltersValue>(() => readFilters(params))
  const [isDrawerOpen, setDrawerOpen] = useState(false)
  const [isCreateOpen, setCreateOpen] = useState(false)
  const [isExporting, setExporting] = useState(false)

  // The input stays instant; only the request waits.
  const debouncedQuery = useDebouncedValue(filters.q, 300)

  const segments = useSegments()
  const recomputeAll = useRecomputeAllMetrics()

  function setFilters(next: CustomerFiltersValue) {
    setFiltersState(next)
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        const entries = Object.entries(next) as Array<[keyof CustomerFiltersValue, string]>
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

  const listParams = toParams(filters, tags, debouncedQuery)
  const query = useCustomers({ page, limit, ...listParams })
  const isFiltered = computeIsFiltered({ ...filters, q: debouncedQuery }, tags)

  /**
   * The export takes the same filters as the list, so what downloads is what is
   * on screen. It is fetched rather than linked, because the CSV is behind the
   * same bearer token as everything else.
   */
  async function exportCsv() {
    setExporting(true)
    try {
      const blob = await customersApi.export(listParams)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'customers.csv'
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast({ tone: 'error', title: 'Could not export', description: messageOf(error) })
    } finally {
      setExporting(false)
    }
  }

  const columns = useMemo<Array<Column<CustomerSummary>>>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">{customerName(row)}</span>
            <span className="text-faint block truncate text-xs">{row.email}</span>
          </div>
        ),
      },
      {
        id: 'orders',
        header: 'Orders',
        align: 'right',
        width: '6rem',
        cell: (row) => <span className="text-ink tabular">{row.ordersCount}</span>,
      },
      {
        id: 'spent',
        header: 'Total spent',
        align: 'right',
        cell: (row) => (
          <div>
            <span className="text-ink tabular font-medium">{formatMoney(row.totalSpent)}</span>
            {row.ordersCount > 1 ? (
              <span className="text-faint tabular block text-xs">
                {formatMoney(row.averageOrderValue)} average
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'lastOrder',
        header: 'Last order',
        hideBelow: 'md',
        cell: (row) =>
          row.lastOrderAt ? (
            <span className="text-muted text-xs">{formatDate(row.lastOrderAt)}</span>
          ) : (
            <span className="text-faint text-xs">Never ordered</span>
          ),
      },
      {
        id: 'marketing',
        header: 'Email marketing',
        width: '11rem',
        hideBelow: 'lg',
        cell: (row) => (
          <Badge size="sm" tone={MARKETING_TONES[row.marketing.email]}>
            {MARKETING_LABELS[row.marketing.email]}
          </Badge>
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
        title="Customers"
        description="Who buys, what they have spent, and what they have agreed to hear about."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void navigate('/customers/segments')}>
              Segments
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Download className="size-4" />}
              isLoading={isExporting}
              onClick={() => void exportCsv()}
            >
              Export
            </Button>
            {canWrite ? (
              <Button leadingIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                New customer
              </Button>
            ) : null}
          </div>
        }
      />

      <Card>
        <div className="border-line flex flex-col gap-3 border-b px-4 py-3 sm:px-5">
          <CustomerFilters
            value={filters}
            onChange={setFilters}
            isFiltered={isFiltered}
            segments={segments.data ?? []}
            isDrawerOpen={isDrawerOpen}
            onDrawerOpenChange={setDrawerOpen}
            trailing={
              canWrite ? (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<RefreshCw className="size-3.5" />}
                  isLoading={recomputeAll.isPending}
                  onClick={() =>
                    recomputeAll.mutate(undefined, {
                      onSuccess: (result) =>
                        toast({
                          tone: 'success',
                          title: 'Lifetime figures rebuilt',
                          description: `${result.customers} customers recalculated from their orders.`,
                        }),
                      onError: (error) =>
                        toast({
                          tone: 'error',
                          title: 'Could not rebuild',
                          description: messageOf(error),
                        }),
                    })
                  }
                >
                  Rebuild totals
                </Button>
              ) : undefined
            }
          />

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
            caption="Customers"
            isLoading={query.isFetching && !query.data}
            onRowClick={(row) => void navigate(`/customers/${row.id}`)}
            emptyState={
              isFiltered ? (
                <EmptyState
                  icon={<Users className="size-5" />}
                  title="No customers match these filters"
                  description="Try a different search, or clear the filters to see everyone."
                  actions={
                    <Button variant="secondary" onClick={() => setFilters(emptyCustomerFilters)}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Users className="size-5" />}
                  title="No customers yet"
                  description="People who order on the storefront appear here, and you can add one by hand."
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

      <CustomerFormDialog
        isOpen={isCreateOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => void navigate(`/customers/${id}`)}
      />
    </div>
  )
}
