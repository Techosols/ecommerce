import { cn } from '@/lib/cn'

const sizes = {
  xs: 'size-3 border',
  sm: 'size-4 border-2',
  md: 'size-5 border-2',
  lg: 'size-8 border-2',
} as const

export interface SpinnerProps {
  size?: keyof typeof sizes
  className?: string
  /** Announced to screen readers; pass `null` when a visible label already says it. */
  label?: string | null
}

export function Spinner({ size = 'md', className, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-live={label ? 'polite' : undefined}
      className={cn('inline-flex', className)}
    >
      <span
        aria-hidden="true"
        className={cn('animate-spin rounded-full border-current/25 border-t-current', sizes[size])}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}
