import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import type { PaginationMeta } from '@/types/api'
import { Button } from './Button'
import { Select } from './Select'

export interface PaginationProps {
  /** Straight from the server's `meta.pagination` — never computed here. */
  pagination: PaginationMeta
  onPageChange: (page: number) => void
  onLimitChange?: (limit: number) => void
  pageSizes?: number[]
  className?: string
}

export function Pagination({
  pagination,
  onPageChange,
  onLimitChange,
  pageSizes = [20, 50, 100],
  className,
}: PaginationProps) {
  const { page, limit, total, totalPages, hasNext, hasPrev } = pagination
  const first = total === 0 ? 0 : (page - 1) * limit + 1
  const last = Math.min(page * limit, total)

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <p className="text-muted text-xs">
        {total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="text-ink-soft font-medium">{formatNumber(first)}</span>–
            <span className="text-ink-soft font-medium">{formatNumber(last)}</span> of{' '}
            <span className="text-ink-soft font-medium">{formatNumber(total)}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        {onLimitChange ? (
          <Select
            size="sm"
            aria-label="Results per page"
            value={String(limit)}
            onChange={(event) => onLimitChange(Number(event.target.value))}
            options={pageSizes.map((size) => ({ value: String(size), label: `${size} / page` }))}
            className="w-30"
          />
        ) : null}

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            iconOnly
            variant="secondary"
            aria-label="Previous page"
            disabled={!hasPrev}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-muted tabular px-2 text-xs whitespace-nowrap">
            Page {formatNumber(page)} of {formatNumber(Math.max(totalPages, 1))}
          </span>
          <Button
            size="sm"
            iconOnly
            variant="secondary"
            aria-label="Next page"
            disabled={!hasNext}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </nav>
  )
}
