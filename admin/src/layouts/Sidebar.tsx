import { NavLink } from 'react-router-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { env } from '@/app/env'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/features/auth/useAuth'
import { navigation, type NavItem } from '@/routes/navigation'

export interface SidebarProps {
  /** Live counts for the badges. Absent keys render no badge at all. */
  counts?: Partial<Record<NonNullable<NavItem['badge']>, number>>
  /** Mobile/tablet drawer state; ignored at `lg` and above. */
  isOpen: boolean
  onClose: () => void
}

/**
 * The navigation rail.
 *
 * One component for both layouts: a permanent column at `lg` and above, and the
 * same markup inside an overlay drawer below it. Duplicating it into a
 * "MobileNav" is how the two silently drift apart.
 *
 * Light, not dark: the dark surface in this admin is the top bar, and two dark
 * regions meeting at a corner make the working area look like a hole. The
 * active item is picked out in **white on the grey** — the same white as the
 * cards it leads to, which is a quieter and more accurate signal than a filled
 * accent block.
 *
 * The store name is not repeated here. It is in the top bar, three centimetres
 * up and to the left.
 */
export function Sidebar({ counts, isOpen, onClose }: SidebarProps) {
  const { can } = useAuth()

  const sections = navigation
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.permission || can(item.permission)),
    }))
    .filter((section) => section.items.length > 0)

  const content = (
    <>
      {/* Only on the drawer: the permanent rail has no header of its own. */}
      <div className="flex h-12 shrink-0 items-center px-3 lg:hidden">
        <span className="text-rail-ink min-w-0 truncate text-[0.8125rem] font-semibold">
          {env.appName}
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close navigation"
          onClick={onClose}
          className="text-rail-muted hover:bg-rail-hover hover:text-rail-ink ml-auto"
        >
          <X className="size-4" />
        </Button>
      </div>

      <nav aria-label="Main" className="flex-1 scrollbar-thin space-y-4 overflow-y-auto px-2 py-3">
        {sections.map((section) => (
          <div key={section.id}>
            <p className="text-rail-muted px-2 pb-1 text-[0.6875rem] font-semibold tracking-wide uppercase">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const count = item.badge ? counts?.[item.badge] : undefined
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={onClose}
                      className={({ isActive }) =>
                        cn(
                          'group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[0.8125rem] font-medium transition-colors',
                          isActive
                            ? 'bg-rail-active text-ink shadow-card'
                            : 'text-rail-ink hover:bg-rail-hover',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon
                            aria-hidden="true"
                            className={cn(
                              'size-4 shrink-0',
                              isActive ? 'text-ink' : 'text-rail-muted group-hover:text-rail-ink',
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {typeof count === 'number' && count > 0 ? (
                            <span
                              className={cn(
                                'tabular shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold',
                                isActive ? 'bg-surface-hover text-ink' : 'bg-line text-rail-ink',
                              )}
                            >
                              {count > 99 ? '99+' : count}
                            </span>
                          ) : null}
                        </>
                      )}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  )

  return (
    <>
      {/* Permanent rail */}
      <aside className="bg-rail hidden w-56 shrink-0 flex-col lg:flex">{content}</aside>

      {/* Drawer, below lg */}
      {isOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            aria-hidden="true"
            onClick={onClose}
            className="animate-fade-in absolute inset-0 bg-black/40"
          />
          <aside className="bg-rail animate-slide-in-left shadow-overlay absolute inset-y-0 left-0 flex w-64 flex-col">
            {content}
          </aside>
        </div>
      ) : null}
    </>
  )
}
