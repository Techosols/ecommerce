import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './Button'

/**
 * The pager, driven entirely by the server's own count.
 *
 * `hasNext` and `totalPages` are computed over the whole result set on the
 * server. Inferring them here from the length of a page is the classic way to
 * get a dead "next" button on the last page, and a missing one when a page
 * happens to come back exactly full.
 */
export function Pagination({ pagination, onPageChange }) {
  if (!pagination || pagination.totalPages <= 1) return null

  const { page, totalPages, hasPrev, hasNext, total } = pagination

  return (
    <nav className="flex items-center justify-between gap-4" aria-label="Pages">
      <p className="text-muted text-sm">
        Page <span className="tabular text-ink font-medium">{page}</span> of{' '}
        <span className="tabular">{totalPages}</span>
        <span className="text-faint"> · {total} products</span>
      </p>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasPrev}
          leadingIcon={<ChevronLeft className="size-4" aria-hidden="true" />}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button size="sm" variant="secondary" disabled={!hasNext} onClick={() => onPageChange(page + 1)}>
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  )
}
