import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, MapPin } from 'lucide-react'
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
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatNumber } from '@/lib/format'
import { useInventoryList, useLocations } from '../hooks/inventory.hooks'
import type { InventoryItemSummary } from '../types/inventory.types'

/**
 * What the shop holds.
 *
 * Three numbers per row, because one is never enough: `on hand` is what is on
 * the shelf, `reserved` is what is spoken for by baskets and unshipped orders,
 * and `available` is the only one that answers "can I sell this". A list that
 * showed on-hand alone would have staff promising stock that is already sold.
 *
 * Narrowing by location changes the *totals*, not which rows appear — so an
 * item held nowhere else still shows at zero, and "we do not have that in
 * Camden" is an answer the screen can give.
 */
export function InventoryListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  useDocumentTitle('Inventory')

  const page = Number(params.get('page') ?? '1')
  const limit = Number(params.get('limit') ?? '20')

  const [search, setSearch] = useState(params.get('q') ?? '')
  const debounced = useDebouncedValue(search, 300)

  const low = params.get('low') === 'true'
  const tracked = params.get('tracked') ?? ''
  const locationId = params.get('locationId') ?? ''

  const locations = useLocations()

  function set(key: string, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        // A narrower filter almost never has the page the operator was on.
        next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  const query = useInventoryList({
    page,
    limit,
    ...(debounced ? { q: debounced } : {}),
    ...(low ? { low: 'true' as const } : {}),
    ...(tracked ? { tracked: tracked as 'true' | 'false' } : {}),
    ...(locationId ? { locationId } : {}),
  })

  const isFiltered = Boolean(debounced) || low || tracked !== '' || locationId !== ''
  const locationName = (locations.data ?? []).find((entry) => entry.id === locationId)?.name

  const columns = useMemo<Array<Column<InventoryItemSummary>>>(
    () => [
      {
        id: 'item',
        header: 'Item',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">{row.productTitle}</span>
            <span className="text-faint block truncate text-xs">
              {row.variantTitle}
              {row.sku ? ` · ${row.sku}` : ''}
            </span>
          </div>
        ),
      },
      {
        id: 'onHand',
        header: 'On hand',
        align: 'right',
        width: '7rem',
        cell: (row) =>
          row.trackInventory ? (
            <span className="text-ink tabular">{formatNumber(row.totals.onHand)}</span>
          ) : (
            <span className="text-faint text-xs">Not counted</span>
          ),
      },
      {
        id: 'reserved',
        header: 'Reserved',
        align: 'right',
        width: '7rem',
        hideBelow: 'sm',
        cell: (row) =>
          row.trackInventory && row.totals.reserved > 0 ? (
            <span className="text-muted tabular">{formatNumber(row.totals.reserved)}</span>
          ) : (
            <span className="text-faint">—</span>
          ),
      },
      {
        id: 'available',
        header: 'Available',
        align: 'right',
        width: '8rem',
        cell: (row) => {
          // Untracked means unconditionally sellable — a made-to-order item.
          // Showing 0 here would be the opposite of the truth.
          if (!row.trackInventory) return <Badge tone="info">Always</Badge>
          return (
            <span
              className={
                row.totals.available <= 0
                  ? 'text-danger tabular font-medium'
                  : row.isLow
                    ? 'text-warning tabular font-medium'
                    : 'text-ink tabular font-medium'
              }
            >
              {formatNumber(row.totals.available)}
            </span>
          )
        },
      },
      {
        id: 'state',
        header: 'State',
        width: '9rem',
        hideBelow: 'md',
        cell: (row) => {
          if (!row.trackInventory) return <span className="text-faint text-xs">Untracked</span>
          if (row.totals.available <= 0) return <Badge tone="danger">Out of stock</Badge>
          if (row.isLow) return <Badge tone="warning">Low</Badge>
          return <span className="text-faint text-xs">In stock</span>
        },
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Inventory"
        actions={
          <Button
            leadingIcon={<MapPin className="size-4" />}
            onClick={() => void navigate('/inventory/locations')}
          >
            Locations
          </Button>
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
                aria-label="Search stock"
                placeholder="Product, variant or SKU…"
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
              <>
                <Select
                  size="sm"
                  aria-label="Location"
                  value={locationId}
                  onChange={(event) => set('locationId', event.target.value)}
                  placeholder="All locations"
                  options={(locations.data ?? [])
                    .filter((location) => location.isActive)
                    .map((location) => ({ value: location.id, label: location.name }))}
                />
                <Select
                  size="sm"
                  aria-label="Stock level"
                  value={low ? 'low' : ''}
                  onChange={(event) => set('low', event.target.value === 'low' ? 'true' : '')}
                  options={[
                    { value: '', label: 'Any level' },
                    { value: 'low', label: 'Low or out' },
                  ]}
                />
                <Select
                  size="sm"
                  aria-label="Tracking"
                  value={tracked}
                  onChange={(event) => set('tracked', event.target.value)}
                  options={[
                    { value: '', label: 'Tracked and not' },
                    { value: 'true', label: 'Counted' },
                    { value: 'false', label: 'Not counted' },
                  ]}
                />
              </>
            }
          />

          {locationName ? (
            <p className="text-muted mt-2 text-xs">
              Showing quantities at <span className="text-ink">{locationName}</span>. Items held
              elsewhere still appear, at zero.
            </p>
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
            caption="Inventory"
            isLoading={query.isFetching && !query.data}
            onRowClick={(row) => void navigate(`/inventory/${row.id}`)}
            emptyState={
              isFiltered ? (
                <EmptyState
                  icon={<Boxes className="size-5" />}
                  title="Nothing matches these filters"
                  description="Try a different search, or clear the filters to see everything you stock."
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
                  icon={<Boxes className="size-5" />}
                  title="Nothing stocked yet"
                  description="Every variant you create gets an inventory item automatically. Receive a delivery against one to put stock on the shelf."
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
    </div>
  )
}
