import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface CardProps {
  className?: string
  children: ReactNode
  /** Removes the border and shadow, for cards nested inside another surface. */
  flush?: boolean
}

/**
 * A white panel on the grey page.
 *
 * Separated from the page by contrast rather than by elevation — a hairline
 * shadow and no border. A stack of bordered cards on a white page reads as one
 * long document with rules drawn through it; white-on-grey reads as separate
 * things, which is what a settings column actually is.
 */
export function Card({ className, flush = false, children }: CardProps) {
  return (
    <section
      className={cn('bg-surface rounded-card', !flush && 'shadow-card', className)}
    >
      {children}
    </section>
  )
}

export interface CardHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Buttons, filters or a link — right-aligned, wrapping below on narrow screens. */
  actions?: ReactNode
  className?: string
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps) {
  return (
    <header
      // No rule under the heading: the padding does the separating, and a card
      // with a line across it looks like a table that lost its rows.
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-ink truncate text-[0.8125rem] font-semibold">{title}</h2>
        {description ? <p className="text-muted mt-0.5 text-xs">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  // 16px all round, and the top padding collapses when a CardHeader is above —
  // the header has already paid it.
  return <div className={cn('px-4 pt-1 pb-4 [&:first-child]:pt-4', className)}>{children}</div>
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer
      className={cn(
        'border-line rounded-b-card flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3',
        className,
      )}
    >
      {children}
    </footer>
  )
}
