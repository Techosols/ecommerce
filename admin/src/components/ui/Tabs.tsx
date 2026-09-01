import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TabItem {
  id: string
  label: ReactNode
  /** A count beside the label — pending orders, unread notifications. */
  count?: number
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  className?: string
}

/**
 * The saved-view tabs across the top of an index — All, Active, Draft, Archived.
 *
 * Pills rather than an underline. Shopify moved to this shape for a reason
 * worth copying: an index page already has a table header rule, a filter row
 * rule and a card edge, and a fourth horizontal line above them all turns the
 * top of the page into a stack of stripes. A selected pill needs no rule.
 */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto p-2', className)}>
      {items.map((item) => {
        const selected = item.id === value
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap transition-colors',
              'disabled:pointer-events-none disabled:opacity-50',
              selected
                ? 'bg-surface-hover text-ink dark:bg-surface-raised'
                : 'text-muted hover:bg-surface-sunken hover:text-ink',
            )}
          >
            {item.label}
            {typeof item.count === 'number' ? (
              <span
                className={cn(
                  'tabular rounded px-1.5 py-0.5 text-[0.6875rem]',
                  selected ? 'bg-line text-ink' : 'bg-surface-sunken text-muted',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" aria-labelledby={id} className="pt-4">
      {children}
    </div>
  )
}
