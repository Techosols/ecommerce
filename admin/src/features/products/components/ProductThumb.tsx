import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface ProductThumbProps {
  url: string | null
  size?: 'sm' | 'md'
  className?: string
}

const sizes = {
  sm: 'size-8',
  md: 'size-10',
} as const

/**
 * The little square at the start of a product row.
 *
 * It carries **no accessible name at all** — no alt text, no label. The
 * product's name is the very next thing in the row, and a thumbnail that
 * announced itself would make every row read "Velvet Matte Lipstick, Velvet
 * Matte Lipstick". The image is decorative *here*, even though the same
 * photograph is not decorative on the product page.
 *
 * A product with no picture gets a muted placeholder rather than nothing: a
 * ragged left edge where some rows have a square and others do not is harder to
 * scan than a column of squares, some of them empty.
 */
export function ProductThumb({ url, size = 'sm', className }: ProductThumbProps) {
  return (
    <span
      className={cn(
        'bg-surface-sunken ring-line flex shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-inset',
        sizes[size],
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <ImageOff aria-hidden="true" className="text-faint size-3.5" />
      )}
    </span>
  )
}
