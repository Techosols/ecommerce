import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { useAuth } from '@/features/auth/useAuth'
import type { Permission } from '@/features/auth/auth.types'

interface SettingsSection {
  to: string
  label: string
  /** Omitted for a section every signed-in operator may open. */
  permission?: Permission
  end?: boolean
}

const SECTIONS: SettingsSection[] = [
  { to: '/settings', label: 'Store', permission: 'settings:read', end: true },
  { to: '/settings/staff', label: 'Staff', permission: 'staff:read' },
  { to: '/settings/audit', label: 'Audit trail', permission: 'audit:read' },
  { to: '/settings/account', label: 'Your account' },
]

/**
 * The four settings sections, and the frame around them.
 *
 * A sub-navigation rather than one long page, because the four have different
 * audiences and different permissions: an operator may administer staff without
 * being able to change the tax rate, and everybody can end their own session
 * without being able to do either. Sections the operator cannot open are not
 * listed — a tab that leads to a refusal is worse than no tab.
 */
export function SettingsLayout() {
  const { can } = useAuth()
  const location = useLocation()
  const visible = SECTIONS.filter((section) => !section.permission || can(section.permission))

  // Everybody can reach Settings, because everybody has an account here. An
  // operator without `settings:read` lands on the first section they can
  // actually open instead of on a refusal they cannot do anything about.
  if (location.pathname === '/settings' && !can('settings:read')) {
    const first = visible[0]
    if (first && first.to !== '/settings') return <Navigate to={first.to} replace />
  }

  return (
    <div className="flex flex-col gap-6">
      {visible.length > 1 ? (
        <nav aria-label="Settings sections" className="border-line flex gap-1 overflow-x-auto border-b">
          {visible.map((section) => (
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
      ) : null}

      <Outlet />
    </div>
  )
}
