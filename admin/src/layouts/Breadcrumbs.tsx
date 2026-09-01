import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { navItemsByPath } from '@/routes/navigation'

/** `order-history` → `Order history`. Falls back for ids and unknown segments. */
function humanise(segment: string): string {
  const decoded = decodeURIComponent(segment)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(decoded)) return 'Details'
  return decoded.replace(/[-_]/g, ' ').replace(/^./, (character) => character.toUpperCase())
}

/**
 * Where the operator is, and the way back out.
 *
 * Derived from the URL rather than declared per page, so a route added later
 * appears here without anyone remembering to register it. Named sections come
 * from the navigation model; anything below them is humanised from the path.
 */
export function Breadcrumbs() {
  const { pathname } = useLocation()
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const crumbs = segments.map((segment, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`
    return { to, label: navItemsByPath.get(to)?.label ?? humanise(segment) }
  })

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="text-muted flex items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1
          return (
            <Fragment key={crumb.to}>
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="text-faint size-3.5 shrink-0" />
              ) : null}
              <li className="min-w-0">
                {isLast ? (
                  <span aria-current="page" className="text-ink truncate font-medium">
                    {crumb.label}
                  </span>
                ) : (
                  <Link to={crumb.to} className="hover:text-ink truncate transition-colors">
                    {crumb.label}
                  </Link>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
