import { Menu, Search, Store } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { env } from '@/app/env'
import { NotificationsMenu } from '@/features/notifications/NotificationsMenu'
import { ConnectionIndicator } from './ConnectionIndicator'
import { UserMenu } from './UserMenu'

export interface TopbarProps {
  onOpenNav: () => void
}

/**
 * The dark bar across the very top.
 *
 * Full width, above the navigation rather than beside it — which is what makes
 * the whole app read as one product with a search box, rather than a sidebar
 * next to a page that happens to have a header.
 *
 * The search field sits in the middle and is deliberately the widest thing
 * here. It is the only control in an admin that a person uses from every
 * screen, and burying it in a page header means it is missing from most of
 * them.
 *
 * Breadcrumbs have moved out: the page header below owns going back, with a
 * single arrow to the parent list. A trail of three links to say "Products →
 * Velvet Matte Lipstick" costs a row of screen and answers a question nobody
 * asked.
 */
export function Topbar({ onOpenNav }: TopbarProps) {
  return (
    <header className="bg-topbar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 px-3 sm:px-4">
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Open navigation"
        onClick={onOpenNav}
        className="text-topbar-ink hover:bg-topbar-hover hover:text-white lg:hidden"
      >
        <Menu className="size-5" />
      </Button>

      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <span className="bg-topbar-hover flex size-7 shrink-0 items-center justify-center rounded-md">
          <Store aria-hidden="true" className="text-topbar-ink size-4" />
        </span>
        <span className="text-topbar-ink hidden min-w-0 truncate text-[0.8125rem] font-semibold sm:block">
          {env.appName}
        </span>
      </div>

      {/* Not wired to anything yet — the server publishes no cross-resource
          search endpoint, only per-resource `q` parameters. It is here because
          the shape of the bar depends on it, and a search box added later
          would push every other control sideways. */}
      <div className="mx-auto hidden w-full max-w-md md:block">
        <label className="sr-only" htmlFor="admin-search">
          Search
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="text-topbar-muted pointer-events-none absolute inset-y-0 left-2.5 my-auto size-4"
          />
          <input
            id="admin-search"
            type="search"
            placeholder="Search"
            disabled
            title="Search across the admin is not available yet"
            className="bg-topbar-field text-topbar-ink placeholder:text-topbar-muted h-8 w-full rounded-lg pr-3 pl-8 text-xs ring-1 ring-white/10 ring-inset outline-none focus:ring-2 focus:ring-white/40 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
        <ConnectionIndicator />
        <NotificationsMenu />
        <UserMenu />
      </div>
    </header>
  )
}
