import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PaginationMeta } from '@/types/api'

export interface SimplePagerProps {
  pagination: PaginationMeta
  onPageChange: (page: number) => void
  className?: string
}

/**
 * Two arrows, centred under the table.
 *
 * Not a numbered pager. Page 7 of a filtered product list is not a place anyone
 * navigates *to* — it is a place they arrive at by pressing Next six times, and
 * the numbers in between are eleven click targets that exist to be ignored.
 * Shopify made this call years ago and the admin is quieter for it.
 *
 * The page count is still announced, quietly, for anyone who wants to know how
 * much is left.
 */
export function SimplePager({ pagination, onPageChange, className }: SimplePagerProps) {
  if (pagination.totalPages <= 1) return null

  return (
    <nav
      aria-label="Pages"
      className={cn('flex items-center justify-center gap-1 py-3', className)}
    >
      <button
        type="button"
        aria-label="Previous page"
        disabled={!pagination.hasPrev}
        onClick={() => onPageChange(pagination.page - 1)}
        className={arrow}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
      </button>

      <span className="text-muted tabular px-2 text-xs">
        {pagination.page} of {pagination.totalPages}
      </span>

      <button
        type="button"
        aria-label="Next page"
        disabled={!pagination.hasNext}
        onClick={() => onPageChange(pagination.page + 1)}
        className={arrow}
      >
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
    </nav>
  )
}

const arrow = cn(
  'text-ink flex size-8 items-center justify-center rounded-lg transition-colors',
  'ring-1 ring-line-strong ring-inset hover:bg-surface-hover',
  'disabled:pointer-events-none disabled:text-faint disabled:ring-line',
)
