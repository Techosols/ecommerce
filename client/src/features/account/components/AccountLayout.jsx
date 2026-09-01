import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { Bell, KeyRound, MapPin, PackageCheck, Receipt, User } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { useAuth } from '../useAuth'
import { useUnreadCount } from '../hooks/notifications.hooks'

const SECTIONS = [
  { to: '/account/orders', label: 'Orders', icon: Receipt },
  { to: '/account/returns', label: 'Returns', icon: PackageCheck },
  { to: '/account/addresses', label: 'Addresses', icon: MapPin },
  { to: '/account/details', label: 'Your details', icon: User },
  { to: '/account/security', label: 'Security', icon: KeyRound },
  { to: '/account/notifications', label: 'Notifications', icon: Bell },
]

/**
 * The signed-in area, and the one place the guard lives.
 *
 * Every account screen needs the same three-way answer — restoring, signed in,
 * signed out — and repeating it per page is how one page eventually gets it
 * wrong. The subtle case is the first: a reload wipes the in-memory access
 * token and the provider mints a new one from the refresh cookie, so "we do not
 * know yet" must not be treated as "signed out". A page that did would bounce a
 * signed-in customer to the login screen on every refresh.
 *
 * Where they were headed travels with the redirect, so signing in returns them
 * to the page they asked for rather than a generic landing.
 */
export function AccountLayout() {
  const { isSignedIn, isRestoring, customer, signOut } = useAuth()
  const location = useLocation()

  if (isRestoring) return <p className="text-muted py-16 text-center">Checking your session…</p>
  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Your account</h1>
          <p className="text-muted text-sm">Signed in as {customer?.email}</p>
        </div>
        <Button onClick={() => void signOut()}>Sign out</Button>
      </header>

      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
        <AccountNav />
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

function AccountNav() {
  // The badge is the reason this is a query and not a static list: an unread
  // count that only appeared after opening the page would be no use.
  const unread = useUnreadCount()

  return (
    <nav aria-label="Account" className="lg:sticky lg:top-24">
      <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
        {SECTIONS.map((section) => (
          <li key={section.to}>
            <NavLink
              to={section.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-ink-soft hover:bg-sunken hover:text-ink',
                )
              }
            >
              <section.icon className="size-4 shrink-0" aria-hidden="true" />
              {section.label}
              {section.label === 'Notifications' && unread.data?.count > 0 ? (
                <span className="bg-copper-500 tabular ml-auto rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium text-white">
                  {unread.data.count > 99 ? '99+' : unread.data.count}
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
