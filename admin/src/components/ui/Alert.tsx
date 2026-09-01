import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

const tones = {
  info: {
    container: 'bg-info-soft border-info/25 text-info',
    Icon: Info,
  },
  positive: {
    container: 'bg-positive-soft border-positive/25 text-positive',
    Icon: CheckCircle2,
  },
  warning: {
    container: 'bg-warning-soft border-warning/30 text-warning',
    Icon: AlertTriangle,
  },
  danger: {
    container: 'bg-danger-soft border-danger/25 text-danger',
    Icon: XCircle,
  },
} as const

export type AlertTone = keyof typeof tones

export interface AlertProps {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  className?: string
}

export function Alert({
  tone = 'info',
  title,
  children,
  actions,
  onDismiss,
  className,
}: AlertProps) {
  const { container, Icon } = tones[tone]

  return (
    <div
      // Errors interrupt; everything else waits for a pause in speech.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-3.5', container, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="text-sm font-semibold">{title}</p> : null}
        {children ? (
          <div className={cn('text-sm', title && 'mt-1', tone !== 'danger' && 'text-ink-soft')}>
            {children}
          </div>
        ) : null}
        {actions ? <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mt-1 -mr-1 shrink-0 text-current hover:bg-black/5 dark:hover:bg-white/10"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  )
}
