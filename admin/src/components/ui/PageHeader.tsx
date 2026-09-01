import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /**
   * Where the back arrow goes — the list this record belongs to.
   *
   * A single arrow to the parent, not a breadcrumb trail. An admin is two
   * levels deep almost everywhere, and "Home → Products → Velvet Matte
   * Lipstick" spends a row of screen restating the page title.
   */
  backTo?: string
  backLabel?: string
  /** Status badges, sitting on the title's line rather than under it. */
  badges?: ReactNode
  className?: string
}

/**
 * The heading every page starts with.
 *
 * The title is 20px semibold — noticeably smaller than a marketing page's, and
 * on purpose. A page in a working tool is read once to confirm where you are;
 * the screen belongs to the data.
 */
export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backLabel,
  badges,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {backTo ? (
          <Link
            to={backTo}
            aria-label={backLabel ?? 'Back'}
            className="text-ink hover:bg-surface-hover -ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors"
          >
            <ChevronLeft aria-hidden="true" className="size-5" />
          </Link>
        ) : null}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-ink truncate text-xl font-semibold">{title}</h1>
            {badges}
          </div>
          {description ? <p className="text-muted mt-0.5 max-w-2xl text-xs">{description}</p> : null}
        </div>
      </div>

      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
