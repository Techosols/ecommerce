import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Skeleton } from './Skeleton'

export interface StatCardProps {
  label: string
  /** Already formatted for display. Nothing in this component does arithmetic. */
  value: ReactNode
  icon?: ReactNode
  /** A server-supplied comparison. Omit it rather than guessing a baseline. */
  delta?: { label: string; direction: 'up' | 'down' | 'flat'; isGood?: boolean }
  hint?: ReactNode
  isLoading?: boolean
  className?: string
}

const arrows = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const

/**
 * One headline figure.
 *
 * A rise is not automatically good — refunds and cancellations going up is bad
 * news — so `isGood` is stated by the caller rather than inferred from the
 * direction of the arrow.
 */
export function StatCard({
  label,
  value,
  icon,
  delta,
  hint,
  isLoading = false,
  className,
}: StatCardProps) {
  const Arrow = delta ? arrows[delta.direction] : null
  const good = delta?.isGood ?? delta?.direction === 'up'

  return (
    <div
      className={cn('bg-surface border-line rounded-card shadow-card border p-4 sm:p-5', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted text-xs font-medium tracking-wide uppercase">{label}</p>
        {icon ? <span className="text-faint shrink-0">{icon}</span> : null}
      </div>

      {isLoading ? (
        <Skeleton className="mt-3 h-8 w-24" />
      ) : (
        <p className="text-ink tabular mt-2 text-2xl font-semibold">{value}</p>
      )}

      <div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1">
        {delta && Arrow && !isLoading ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              delta.direction === 'flat' ? 'text-muted' : good ? 'text-positive' : 'text-danger',
            )}
          >
            <Arrow aria-hidden="true" className="size-3.5" />
            {delta.label}
          </span>
        ) : null}
        {hint ? <span className="text-faint text-xs">{hint}</span> : null}
      </div>
    </div>
  )
}
