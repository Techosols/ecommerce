import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

const tones = {
  neutral: 'bg-surface-sunken text-faint',
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const

export interface StatePanelProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
  tone?: keyof typeof tones
  /** `page` centres in the viewport; `inline` sits inside a card or a table. */
  variant?: 'inline' | 'page'
  className?: string
}

/**
 * The shared skeleton behind every non-content state.
 *
 * Empty, error, forbidden and offline all look the same on purpose: an operator
 * learns one shape — icon, one-line title, a sentence saying what to do, and at
 * most two buttons — and reads the difference from the words, not the layout.
 */
export function StatePanel({
  icon,
  title,
  description,
  actions,
  tone = 'neutral',
  variant = 'inline',
  className,
}: StatePanelProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        variant === 'page' ? 'min-h-[60vh] py-12' : 'py-10',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('mb-4 flex size-11 items-center justify-center rounded-full', tones[tone])}
      >
        {icon}
      </span>
      <h2 className="text-ink text-base font-semibold">{title}</h2>
      {description ? (
        <p className="text-muted mt-1.5 max-w-sm text-sm text-balance">{description}</p>
      ) : null}
      {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  )
}
