import { cn } from '@/lib/cn'

export interface SkeletonProps {
  className?: string
}

/**
 * A placeholder shaped like the content that is coming.
 *
 * Always `aria-hidden`: the loading state is announced once by whatever wraps
 * the region, not once per grey rectangle.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-surface-sunken relative block overflow-hidden rounded-md',
        'after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.6s_infinite]',
        'after:bg-gradient-to-r after:from-transparent after:via-black/[0.045] after:to-transparent',
        'dark:after:via-white/[0.06]',
        className,
      )}
    />
  )
}

/** Convenience for a paragraph-shaped placeholder. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}
