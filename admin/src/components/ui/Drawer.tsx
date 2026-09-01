import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap, useLockBodyScroll } from '@/hooks/useFocusTrap'
import { Button } from './Button'

const widths = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
} as const

export interface DrawerProps {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  size?: keyof typeof widths
  footer?: ReactNode
  dismissible?: boolean
  children: ReactNode
}

/**
 * A side sheet for editing one record without leaving the list.
 *
 * A drawer rather than a modal for anything with more than a few fields: it can
 * be tall, it scrolls its own body, and the list stays visible behind it so the
 * operator keeps their place. Below `sm` it becomes a full-height sheet,
 * because a 400px panel on a phone is a modal with extra steps.
 *
 * Focus handling is the same as `Modal` — trap, restore, Escape — because a
 * keyboard user should not have to learn two overlays.
 */
export function Drawer({
  isOpen,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  dismissible = true,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEscapeKey(onClose, isOpen && dismissible)
  useFocusTrap(panelRef, isOpen)
  useLockBodyScroll(isOpen)

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        aria-hidden="true"
        onClick={dismissible ? onClose : undefined}
        className="animate-fade-in absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        className={cn(
          'bg-surface shadow-overlay animate-slide-in-right relative flex h-full w-full flex-col',
          widths[size],
        )}
      >
        <header className="border-line flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-ink text-base font-semibold">{title}</h2>
            {description ? <p className="text-muted mt-1 text-sm">{description}</p> : null}
          </div>
          {dismissible ? (
            <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose}>
              <X className="size-4" />
            </Button>
          ) : null}
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="border-line bg-surface-sunken flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
