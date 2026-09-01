import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export interface FilterBarProps {
  /** The search field, given the full width on narrow screens. */
  search?: ReactNode
  /** Selects and toggles, wrapping beside the search field. */
  filters?: ReactNode
  /** True when anything is narrowing the list, which reveals "Clear". */
  isFiltered?: boolean
  onClear?: () => void
  /** Right-aligned: bulk actions, a view switch, a count. */
  trailing?: ReactNode
  className?: string
}

/**
 * The strip above a list.
 *
 * A layout component, not a filtering component: it knows nothing about what is
 * being filtered, so every list in the admin can put its own controls in the
 * same place and get the same behaviour on a phone.
 */
export function FilterBar({
  search,
  filters,
  isFiltered = false,
  onClear,
  trailing,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {search ? <div className="min-w-48 flex-1 sm:max-w-xs">{search}</div> : null}
      {filters}

      {isFiltered && onClear ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          leadingIcon={<X className="size-3.5" />}
        >
          Clear
        </Button>
      ) : null}

      {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
    </div>
  )
}
