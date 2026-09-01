import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useDisclosure } from '@/hooks/useDisclosure'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useOnClickOutside } from '@/hooks/useOnClickOutside'
import { DropdownContext, useDropdownClose, type DropdownContextValue } from './dropdown.context'

export interface DropdownMenuProps {
  /** Receives the props that make it a proper menu button. */
  trigger: (props: {
    onClick: () => void
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    ref: React.Ref<HTMLButtonElement>
  }) => ReactNode
  align?: 'start' | 'end'
  /** Panel width classes; the default suits a short action list. */
  width?: string
  children: ReactNode
  className?: string
}

/**
 * A small anchored menu.
 *
 * Positioned with plain absolute layout rather than a floating-element library:
 * every menu in the admin is anchored to a header or a table row, and those all
 * sit inside a scroll container that a portal would escape. If a case ever
 * genuinely needs collision detection, that is the moment to add the dependency.
 *
 * The panel is mounted only while open, so a menu whose contents fetch data
 * (the notifications bell) costs nothing until somebody opens it.
 */
export function DropdownMenu({
  trigger,
  align = 'end',
  width = 'w-56',
  children,
  className,
}: DropdownMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { isOpen, close, toggle } = useDisclosure()

  // Returning focus to the trigger is what makes a keyboard user's next Tab
  // continue from the menu rather than from the top of the page.
  const dismiss = useCallback(() => {
    close()
    triggerRef.current?.focus()
  }, [close])

  useOnClickOutside(containerRef, close, isOpen)
  useEscapeKey(dismiss, isOpen)

  const context = useMemo<DropdownContextValue>(() => ({ close: dismiss }), [dismiss])

  return (
    // Clicks inside a menu stop here. A dropdown very often sits in a clickable
    // table row, and without this the row's own handler fires too — opening the
    // menu navigates away, and choosing an item navigates away instead of doing
    // what it says. Containing it here means no caller has to remember.
    <div
      ref={containerRef}
      onClick={(event) => event.stopPropagation()}
      className={cn('relative', className)}
    >
      {trigger({
        onClick: toggle,
        'aria-expanded': isOpen,
        'aria-haspopup': 'menu',
        ref: triggerRef,
      })}

      {isOpen ? (
        <DropdownContext.Provider value={context}>
          <div
            role="menu"
            className={cn(
              'bg-surface-raised border-line shadow-overlay animate-pop-in absolute top-full z-40 mt-1.5',
              'rounded-xl border p-1',
              align === 'end' ? 'right-0' : 'left-0',
              width,
            )}
          >
            {children}
          </div>
        </DropdownContext.Provider>
      ) : null}
    </div>
  )
}

export interface DropdownItemProps {
  onSelect?: () => void
  icon?: ReactNode
  disabled?: boolean
  tone?: 'default' | 'danger'
  /** Set false for an item that toggles a setting the operator may set twice. */
  closeOnSelect?: boolean
  children: ReactNode
  className?: string | undefined
}

export function DropdownItem({
  onSelect,
  icon,
  disabled = false,
  tone = 'default',
  closeOnSelect = true,
  children,
  className,
}: DropdownItemProps) {
  const close = useDropdownClose()

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onSelect?.()
        if (closeOnSelect) close()
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        tone === 'danger'
          ? 'text-danger hover:bg-danger-soft'
          : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
        className,
      )}
    >
      {icon ? <span className="text-faint shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-faint px-2.5 pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wide uppercase">
      {children}
    </p>
  )
}

export function DropdownSeparator() {
  return <hr className="border-line my-1 border-t" />
}
