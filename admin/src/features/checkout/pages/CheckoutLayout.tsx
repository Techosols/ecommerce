import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { PageHeader } from '@/components/ui/PageHeader'

const SECTIONS = [
  { to: '/checkout', label: 'Baskets', end: true },
  { to: '/checkout/attempts', label: 'Attempts' },
]

/**
 * Sales that did not complete.
 *
 * Two views of the same failure, which is why they share a page rather than
 * sitting in two corners of the menu: a basket somebody filled and left, and a
 * checkout somebody tried and was refused. The first is a sale you might still
 * get; the second is one the shop turned away, usually for a reason worth
 * fixing.
 */
export function CheckoutLayout() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Checkout"
        description="Baskets people left, and checkouts the shop refused."
      />

      <nav
        aria-label="Checkout sections"
        className="border-line flex gap-1 overflow-x-auto border-b"
      >
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end ?? false}
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                isActive
                  ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                  : 'text-muted hover:text-ink border-transparent',
              )
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  )
}
