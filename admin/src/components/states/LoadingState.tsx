import { cn } from '@/lib/cn'
import { Skeleton } from '@/components/ui/Skeleton'
import { Spinner } from '@/components/ui/Spinner'

export interface LoadingStateProps {
  label?: string
  variant?: 'inline' | 'page'
  className?: string
}

export function LoadingState({
  label = 'Loading…',
  variant = 'inline',
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        'text-muted flex flex-col items-center justify-center gap-3',
        variant === 'page' ? 'min-h-[60vh]' : 'py-10',
        className,
      )}
    >
      <Spinner size="lg" label={null} className="text-brand-600" />
      <p role="status" className="text-sm">
        {label}
      </p>
    </div>
  )
}

/**
 * The shape of a dashboard while its numbers are in flight.
 *
 * A skeleton that matches the real layout is worth more than a spinner here:
 * the page does not jump when the data lands, so the operator's eye is already
 * where the figure will appear.
 */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="bg-surface border-line rounded-card border p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-28" />
            <Skeleton className="mt-3 h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="rounded-card h-64 lg:col-span-2" />
        <Skeleton className="rounded-card h-64" />
      </div>
    </div>
  )
}
