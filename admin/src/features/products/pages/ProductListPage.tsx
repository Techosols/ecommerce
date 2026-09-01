import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowUpDown, Package, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DropdownItem, DropdownMenu } from '@/components/ui/DropdownMenu'
import { PageHeader } from '@/components/ui/PageHeader'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { SimplePager } from '@/components/ui/SimplePager'
import { DataTable, type Column, type SortState } from '@/components/ui/Table'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { RequirePermission } from '@/features/auth/RequirePermission'
import { useAuth } from '@/features/auth/useAuth'
import { BulkActionBar } from '@/features/collections/components/BulkActionBar'
import { useCategoryTree } from '@/features/categories/hooks/categories.hooks'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useProducts } from '../hooks/products.hooks'
import { ProductStatusBadge } from '../components/ProductStatusBadge'
import { ProductThumb } from '../components/ProductThumb'
import type { ProductSortKey, ProductStatus, ProductSummary } from '../types/products.types'

const SORT_KEYS: ProductSortKey[] = ['created', 'updated', 'title', 'status']

/**
 * The saved views across the top.
 *
 * Backed by the `status` filter rather than by anything stored: the server has
 * no saved-view resource, so these are the four views every catalogue wants,
 * spelled as tabs. A "+" to define your own would be a control that cannot save
 * anything.
 */
const VIEWS: { id: string; label: string; status: ProductStatus | '' }[] = [
  { id: 'all', label: 'All', status: '' },
  { id: 'active', label: 'Active', status: 'active' },
  { id: 'draft', label: 'Draft', status: 'draft' },
  { id: 'archived', label: 'Archived', status: 'archived' },
]

const SORT_OPTIONS: { key: ProductSortKey; direction: 'asc' | 'desc'; label: string }[] = [
  { key: 'title', direction: 'asc', label: 'Product title A–Z' },
  { key: 'title', direction: 'desc', label: 'Product title Z–A' },
  { key: 'created', direction: 'desc', label: 'Created (newest first)' },
  { key: 'created', direction: 'asc', label: 'Created (oldest first)' },
  { key: 'updated', direction: 'desc', label: 'Updated (newest first)' },
  { key: 'updated', direction: 'asc', label: 'Updated (oldest first)' },
]

/**
 * The product list.
 *
 * Every narrowing happens on the server: `q`, `status`, `categoryId`, the sort
 * and the page are all query parameters, and one page of rows is all that is
 * ever in the browser. Filtering a locally-held array would be a lie the moment
 * the catalogue outgrew a single page.
 *
 * The filter state lives in the URL, so a filtered view can be bookmarked, sent
 * to a colleague, and survives the back button.
 *
 * ## What this table shows, and what it cannot
 *
 * The inventory column reads "24 in stock for 3 variants", and the two halves
 * come from different places for a reason: the count is of *live* variants and
 * the number is summed over *tracked* ones only. A product with nothing tracked
 * shows no number at all rather than a zero, because "we do not count these"
 * and "there are none" are different sentences.
 *
 * Price and SKU are still absent. Those are per-variant and a product with six
 * variants has six of each; the product page answers for one product with one
 * request, which a list column cannot.
 */
export function ProductListPage() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const canWrite = can('catalog:write')
  // Ids rather than rows, so a selection survives paging and filtering: the
  // bulk endpoint takes ids and nothing else about a row is needed.
  const [selected, setSelected] = useState<string[]>([])
  const navigate = useNavigate()
  const { byId: categoriesById, flat: categoryTree } = useCategoryTree()
  useDocumentTitle('Products')

  const page = Number(params.get('page') ?? '1')
  const limit = Number(params.get('limit') ?? '20')
  const sortKey = (params.get('sort') ?? 'created') as ProductSortKey
  const direction = params.get('direction') === 'asc' ? 'asc' : 'desc'

  const status = (params.get('status') ?? '') as ProductStatus | ''
  const categoryId = params.get('categoryId') ?? ''
  const [queryText, setQueryText] = useState(params.get('q') ?? '')

  // The input stays instant; only the request waits. Without this, "burger" is
  // six requests, five of them stale before they land.
  const debouncedQuery = useDebouncedValue(queryText, 300)

  /** Every filter change drops the page: a narrower result rarely has page 4. */
  function patchParams(changes: Record<string, string>) {
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        for (const [key, value] of Object.entries(changes)) {
          if (value) search.set(key, value)
          else search.delete(key)
        }
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

  function setSort(next: SortState) {
    patchParams({ sort: next.key, direction: next.direction })
  }

  const query = useProducts({
    page,
    limit,
    ...(debouncedQuery ? { q: debouncedQuery } : {}),
    ...(status ? { status } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(SORT_KEYS.includes(sortKey) ? { sort: sortKey, direction } : {}),
  })

  const activeView = VIEWS.find((view) => view.status === status)?.id ?? 'all'
  // The tabs are not a filter — switching view is switching view. Only the
  // search box and the category select count as "filtered".
  const isFiltered = Boolean(debouncedQuery || categoryId)

  const columns = useMemo<Array<Column<ProductSummary>>>(
    () => [
      {
        id: 'title',
        header: 'Product',
        sortKey: 'title',
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-3">
            <ProductThumb url={row.imageUrl} />
            <Link
              to={`/products/${row.id}`}
              onClick={(event) => event.stopPropagation()}
              className="text-ink hover:underline min-w-0 truncate font-medium"
            >
              {row.title}
            </Link>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortKey: 'status',
        width: '7rem',
        cell: (row) => <ProductStatusBadge status={row.status} />,
      },
      {
        id: 'inventory',
        header: 'Inventory',
        // Wide enough for "2997 in stock for 10 variants" on one line. Wrapped
        // to three lines it triples the row height and the table stops being
        // scannable, which is the whole job of an index.
        width: '15rem',
        cell: (row) => <InventoryCell row={row} />,
      },
      {
        id: 'category',
        header: 'Category',
        hideBelow: 'md',
        // Truncated rather than wrapped. "Prepared Foods" over two lines makes
        // that one row taller than its neighbours, and a table whose rows are
        // different heights stops being scannable.
        cell: (row) => {
          if (!row.categoryId) return <span className="text-faint">—</span>
          const category = categoriesById.get(row.categoryId)
          if (!category) return <span className="text-faint">Unknown</span>
          return (
            <span className="block max-w-[10rem] truncate" title={category.name}>
              {category.name}
            </span>
          )
        },
      },
      {
        id: 'type',
        header: 'Type',
        hideBelow: 'lg',
        cell: (row) =>
          row.productType ? (
            <span className="block max-w-[10rem] truncate" title={row.productType}>
              {row.productType}
            </span>
          ) : (
            <span className="text-faint">—</span>
          ),
      },
      {
        id: 'vendor',
        header: 'Vendor',
        hideBelow: 'lg',
        cell: (row) =>
          row.vendor ? (
            <span className="block max-w-[10rem] truncate" title={row.vendor}>
              {row.vendor}
            </span>
          ) : (
            <span className="text-faint">—</span>
          ),
      },
    ],
    [categoriesById],
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Products"
        actions={
          <RequirePermission permission="catalog:write">
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => void navigate('/products/new')}
            >
              Add product
            </Button>
          </RequirePermission>
        }
      />

      <Card flush className="shadow-card overflow-hidden">
        <Tabs
          items={VIEWS.map((view) => ({ id: view.id, label: view.label }))}
          value={activeView}
          onChange={(id) => {
            const view = VIEWS.find((entry) => entry.id === id)
            patchParams({ status: view?.status ?? '' })
          }}
          className="border-line border-b"
        />

        {/* Search, filter and sort on one row, the way an index reads: what am
            I looking for, narrowed by what, in what order. */}
        <div className="border-line flex flex-wrap items-center gap-2 border-b px-2 py-2">
          <div className="min-w-[12rem] flex-1">
            <SearchInput
              size="sm"
              aria-label="Search products"
              placeholder="Searching all products"
              value={queryText}
              onChange={(event) => {
                setQueryText(event.target.value)
                patchParams({ q: event.target.value })
              }}
              onClear={() => {
                setQueryText('')
                patchParams({ q: '' })
              }}
            />
          </div>

          <Select
            size="sm"
            aria-label="Filter by category"
            className="w-44"
            value={categoryId}
            onChange={(event) => patchParams({ categoryId: event.target.value })}
            options={[
              { value: '', label: 'All categories' },
              // Indented by depth so a child reads as a child; the value is
              // still the flat id the endpoint takes.
              ...categoryTree.map((category) => ({
                value: category.id,
                label: `${'\u00a0\u00a0'.repeat(category.depth)}${category.name}`,
              })),
            ]}
          />

          <DropdownMenu
            align="end"
            width="14rem"
            trigger={(props) => (
              <Button
                size="sm"
                aria-label="Sort products"
                leadingIcon={<ArrowUpDown className="size-3.5" />}
                {...props}
              >
                Sort
              </Button>
            )}
          >
            {SORT_OPTIONS.map((option) => (
              <DropdownItem
                key={`${option.key}-${option.direction}`}
                onSelect={() => setSort({ key: option.key, direction: option.direction })}
              >
                <span
                  className={
                    option.key === sortKey && option.direction === direction
                      ? 'text-ink font-medium'
                      : undefined
                  }
                >
                  {option.label}
                </span>
              </DropdownItem>
            ))}
          </DropdownMenu>
        </div>

        {/* Only once something is selected: an action bar with nothing to act
            on is a permanent piece of furniture nobody reads. */}
        {canWrite && selected.length > 0 ? (
          <div className="border-line border-b px-2 py-2">
            <BulkActionBar productIds={selected} onClear={() => setSelected([])} />
          </div>
        ) : null}

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            getRowId={(row) => row.id}
            caption="Products"
            isLoading={query.isFetching && !query.data}
            sort={{ key: sortKey, direction }}
            onSortChange={setSort}
            onRowClick={(row) => void navigate(`/products/${row.id}`)}
            {...(canWrite ? { selectedIds: selected, onSelectionChange: setSelected } : {})}
            emptyState={
              isFiltered ? (
                <EmptyState
                  icon={<Package className="size-5" />}
                  title="No products found"
                  description="Try changing the filters or search term."
                  actions={
                    <Button
                      onClick={() => {
                        setQueryText('')
                        patchParams({ q: '', categoryId: '' })
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Package className="size-5" />}
                  title="No products yet"
                  description="Add the first product and it will appear here."
                  actions={
                    <RequirePermission permission="catalog:write">
                      <Button variant="primary" onClick={() => void navigate('/products/new')}>
                        Add product
                      </Button>
                    </RequirePermission>
                  }
                />
              )
            }
          />

          {query.data && query.data.items.length > 0 ? (
            <div className="border-line border-t">
              <SimplePager pagination={query.data.pagination} onPageChange={setPage} />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>
    </div>
  )
}

/**
 * "24 in stock for 3 variants" — and the three ways that sentence goes wrong.
 *
 * A product with nothing tracked shows the variant count alone: inventing "0 in
 * stock" for a made-to-order item is how a kitchen's whole menu looks sold out.
 * A tracked product at zero says so, in red, because that one *is* a problem.
 */
function InventoryCell({ row }: { row: ProductSummary }) {
  const variants = `${row.variantCount} ${row.variantCount === 1 ? 'variant' : 'variants'}`

  if (row.available === null) {
    return <span className="text-muted text-xs whitespace-nowrap">Not tracked · {variants}</span>
  }

  return (
    <span className="text-xs whitespace-nowrap">
      <span className={row.available > 0 ? 'text-ink' : 'text-danger font-medium'}>
        {row.available} in stock
      </span>
      <span className="text-muted"> for {variants}</span>
    </span>
  )
}

/** Kept exported so the tags column can come back without a new import. */
export function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-faint">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 2).map((tag) => (
        <Badge key={tag} size="sm">
          {tag}
        </Badge>
      ))}
      {tags.length > 2 ? <Badge size="sm">+{tags.length - 2}</Badge> : null}
    </div>
  )
}
