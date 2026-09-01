import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { StatePanel } from './StatePanel'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  variant?: 'inline' | 'page'
  className?: string
}

/**
 * Nothing here — and that is not a failure.
 *
 * A filtered list with no matches and a genuinely empty resource want different
 * words ("No orders match these filters" vs "No orders yet"), so the title is
 * always the caller's to write.
 */
export function EmptyState({
  title,
  description,
  icon,
  actions,
  variant = 'inline',
  className,
}: EmptyStateProps) {
  return (
    <StatePanel
      icon={icon ?? <Inbox className="size-5" />}
      title={title}
      {...(description !== undefined ? { description } : {})}
      {...(actions !== undefined ? { actions } : {})}
      variant={variant}
      {...(className !== undefined ? { className } : {})}
    />
  )
}
