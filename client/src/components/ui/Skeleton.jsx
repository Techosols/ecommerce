import { cn } from '@/lib/cn'

/**
 * A placeholder shaped like the thing that is coming.
 *
 * Shaped, not generic: a box the size of the eventual card stops the page
 * jumping when the data lands, which is the whole point of showing one.
 */
export function Skeleton({ className }) {
  return <div aria-hidden="true" className={cn('bg-sunken animate-pulse rounded-md', className)} />
}
