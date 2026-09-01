import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BadgePercent, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDate } from '@/lib/format'
import { CreateDiscountDialog } from '../components/CreateDiscountDialog'
import {
  APPLIES_TO_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  describeUsage,
  describeValue,
} from '../components/discountLabels'
import { useDiscounts } from '../hooks/discounts.hooks'
import type { DiscountStatus, DiscountSummary } from '../types/discounts.types'

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'expired', label: 'Expired' },
  { value: 'exhausted', label: 'Used up' },
  { value: 'inactive', label: 'Off' },
  { value: 'archived', label: 'Archived' },
]

/**
 * Every code the shop has.
 *
 * The column that matters is **status**, and it is the server's answer rather
 * than this page's: six columns decide whether a code works — archived, off,
 * not started, finished, used up — and a console that re-derived them would
 * eventually tell somebody a code is live while checkout refuses it.
 *
 * `usage` is shown against its limit for the same reason a stock figure is
 * shown against its threshold: "47" answers nothing, and "47 of 100" says
 * whether the campaign is about to stop.
 */
export function DiscountListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const currency = useStoreCurrency()
  useDocumentTitle('Discounts')

  const page = Number(params.get('page') ?? '1')
  const status = params.get('status') ?? ''
  const [search, setSearch] = useState(params.get('q') ?? '')
  const debounced = useDebouncedValue(search, 300)
  const [creating, setCreating] = useState(false)

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

  const query = useDiscounts({
    page,
    limit: 20,
    ...(debounced ? { q: debounced } : {}),
    ...(status ? { status: status as DiscountStatus } : {}),
    // Archived codes are hidden unless they are what you asked for. They are
    // kept for the orders that cite them, not for browsing.
    ...(status === 'archived' ? { includeArchived: 'true' as const } : {}),
  })

  const isFiltered = Boolean(debounced) || status !== ''

  const columns = useMemo<Array<Column<DiscountSummary>>>(
    () => [
      {
        id: 'code',
        header: 'Code',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">{row.code}</span>
            <span className="text-faint block truncate text-xs">{row.title}</span>
          </div>
        ),
      },
      {
        id: 'value',
        header: 'Takes off',
        width: '10rem',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block text-sm">{describeValue(row, currency)}</span>
            {row.appliesTo !== 'order' ? (
              <span className="text-faint block truncate text-xs">
                {APPLIES_TO_LABELS[row.appliesTo]}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'usage',
        header: 'Used',
        width: '9rem',
        hideBelow: 'sm',
        cell: (row) => (
          <span
            className={row.status === 'exhausted' ? 'text-warning text-sm' : 'text-muted text-sm'}
          >
            {describeUsage(row)}
          </span>
        ),
      },
      {
        id: 'window',
        header: 'Runs',
        width: '12rem',
        hideBelow: 'md',
        cell: (row) => {
          if (!row.startsAt && !row.endsAt) {
            return <span className="text-faint text-xs">No end date</span>
          }
          return (
            <span className="text-muted text-xs">
              {row.startsAt ? formatDate(row.startsAt) : 'Now'} —{' '}
              {row.endsAt ? formatDate(row.endsAt) : 'no end'}
            </span>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        width: '8rem',
        cell: (row) => <Badge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
      },
    ],
    [currency],
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Discounts"
        description="Codes a customer types at checkout, and what each one takes off."
        actions={
          can('discounts:write') ? (
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setCreating(true)}
            >
              New discount
            </Button>
          ) : undefined
        }
      />

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={isFiltered}
            onClear={() => {
              setSearch('')
              setParams(new URLSearchParams(), { replace: true })
            }}
            search={
              <SearchInput
                size="sm"
                aria-label="Search discounts"
                placeholder="Code or name…"
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
                aria-label="Status"
                value={status}
                onChange={(event) => set('status', event.target.value)}
                options={STATUS_OPTIONS}
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
            caption="Discounts"
            onRowClick={(row) => void navigate(`/discounts/${row.id}`)}
            emptyState={
              isFiltered ? (
                <EmptyState
                  icon={<BadgePercent className="size-5" />}
                  title="Nothing matches those filters"
                  description="Try a different code, or clear the filters to see every discount."
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
              ) : (
                <EmptyState
                  icon={<BadgePercent className="size-5" />}
                  title="No discounts yet"
                  description="A discount is a code a customer types at checkout. Nothing is discounted until one exists and is live."
                  actions={
                    can('discounts:write') ? (
                      <Button onClick={() => setCreating(true)}>Create the first one</Button>
                    ) : undefined
                  }
                />
              )
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

      {creating ? <CreateDiscountDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}
