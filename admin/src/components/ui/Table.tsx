import type { ReactNode } from 'react'
import { Checkbox } from './Checkbox'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Skeleton } from './Skeleton'

export interface Column<T> {
  /** Stable key; also used as the React key for cells. */
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** `right` for money and counts, so decimal points line up. */
  align?: 'left' | 'right' | 'center'
  /** Hides the column below `lg` rather than letting the table scroll forever. */
  hideBelow?: 'sm' | 'md' | 'lg'
  width?: string
  className?: string
  /**
   * The key this column sorts by, as the *server* names it.
   *
   * Sorting is always delegated: re-ordering the page in the browser would
   * only rearrange the twenty rows already fetched, which looks like sorting
   * and is not. A column without this is simply not sortable.
   */
  sortKey?: string
}

export interface SortState {
  key: string
  direction: 'asc' | 'desc'
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>
  rows: T[]
  getRowId: (row: T) => string
  isLoading?: boolean
  /** Rendered in place of the table body when there are no rows. */
  emptyState?: ReactNode
  onRowClick?: (row: T) => void
  skeletonRows?: number
  className?: string
  caption?: string
  /** Current server-side sort; omit along with `onSortChange` for a fixed order. */
  sort?: SortState | undefined
  onSortChange?: (sort: SortState) => void
  /**
   * Selected row ids. Supplying `onSelectionChange` is what turns selection on;
   * a table without it renders no checkbox column at all.
   */
  selectedIds?: string[]
  onSelectionChange?: (ids: string[]) => void
}

const hideClasses = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
} as const

const alignClasses = {
  left: 'text-left',
  right: 'text-right tabular',
  center: 'text-center',
} as const

/**
 * The admin's one table.
 *
 * It owns the loading skeleton and the empty state as well as the rows, because
 * a table whose caller has to remember those is a table that ships without
 * them.
 *
 * Sorting is rendered here but decided by the server: clicking a header reports
 * a key and a direction upward, and new rows arrive from a new request. It does
 * not own filtering — that arrives with the feature that needs it, shaped by
 * that feature's API.
 *
 * Selection is owned here because every list that has it needs the same three
 * fiddly things: a header box that is indeterminate when only some of the page
 * is chosen, a click on the box that does not also open the row, and selection
 * that survives paging because the ids live with the caller.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  isLoading = false,
  emptyState,
  onRowClick,
  skeletonRows = 5,
  className,
  caption,
  sort,
  onSortChange,
  selectedIds,
  onSelectionChange,
}: DataTableProps<T>) {
  const showEmpty = !isLoading && rows.length === 0
  const selectable = Boolean(onSelectionChange)
  const selected = new Set(selectedIds ?? [])
  const pageIds = rows.map(getRowId)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const someOnPage = pageIds.some((id) => selected.has(id))

  function toggleRow(id: string) {
    if (!onSelectionChange) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange([...next])
  }

  function togglePage() {
    if (!onSelectionChange) return
    const next = new Set(selected)
    // Selecting "all" means all *on this page*: the table has never seen the
    // rest, and quietly selecting rows nobody has looked at is how a bulk
    // action goes wrong.
    if (allOnPage) for (const id of pageIds) next.delete(id)
    else for (const id of pageIds) next.add(id)
    onSelectionChange([...next])
  }

  function toggleSort(key: string) {
    if (!onSortChange) return
    // A first click on a new column sorts descending — for dates and counts
    // that is the interesting end, and a second click flips it.
    const direction = sort?.key === key && sort.direction === 'desc' ? 'asc' : 'desc'
    onSortChange({ key, direction })
  }

  return (
    <div className={cn('w-full', className)}>
      <div className="w-full scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-line border-b">
              {selectable ? (
                <th scope="col" className="bg-surface-sunken w-10 px-4 py-2.5">
                  <Checkbox
                    checked={allOnPage}
                    indeterminate={someOnPage && !allOnPage}
                    aria-label={allOnPage ? 'Clear selection' : 'Select every row on this page'}
                    onChange={togglePage}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const sortable = Boolean(column.sortKey && onSortChange)
                const active = sortable && sort?.key === column.sortKey
                const Arrow = active
                  ? sort?.direction === 'asc'
                    ? ArrowUp
                    : ArrowDown
                  : ChevronsUpDown

                return (
                  <th
                    key={column.id}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={
                      active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      // A plain white header row with a rule under it, not a
                      // grey band. Shopify's tables are one continuous white
                      // surface; the tint went to the *selected* row instead,
                      // where it carries meaning.
                      'text-muted border-line border-b px-3 py-2 text-xs font-medium whitespace-nowrap',
                      alignClasses[column.align ?? 'left'],
                      column.hideBelow && hideClasses[column.hideBelow],
                      column.className,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.sortKey!)}
                        className={cn(
                          'hover:text-ink -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors',
                          active && 'text-ink',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        <Arrow
                          aria-hidden="true"
                          className={cn('size-3', active ? 'opacity-100' : 'opacity-40')}
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {isLoading
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`} className="border-line border-b last:border-0">
                    {selectable ? <td className="w-10 px-3 py-2.5" /> : null}
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          'px-4 py-3',
                          column.hideBelow && hideClasses[column.hideBelow],
                        )}
                      >
                        <Skeleton className="h-4 w-full max-w-[10rem]" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr
                    key={getRowId(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      'border-line border-b transition-colors last:border-0',
                      onRowClick && 'hover:bg-surface-sunken cursor-pointer',
                      // A selected row is tinted for the whole row, so a
                      // half-selected page is legible without reading boxes.
                      selected.has(getRowId(row)) && 'bg-brand-50 dark:bg-brand-900/20',
                    )}
                  >
                    {selectable ? (
                      <td
                        className="w-10 px-3 py-2.5 align-middle"
                        // Selecting is not opening: without this a click on the
                        // box also navigates to the row it just selected.
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={selected.has(getRowId(row))}
                          aria-label="Select row"
                          onChange={() => toggleRow(getRowId(row))}
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          'text-ink px-3 py-2.5 align-middle',
                          alignClasses[column.align ?? 'left'],
                          column.hideBelow && hideClasses[column.hideBelow],
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {showEmpty ? <div className="px-4 py-10">{emptyState}</div> : null}
    </div>
  )
}
