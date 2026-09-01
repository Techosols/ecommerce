import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap, useLockBodyScroll } from '@/hooks/useFocusTrap'
import { Button } from './Button'

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const

export interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  size?: keyof typeof widths
  /** Buttons for the footer. Omit for a purely informational dialog. */
  footer?: ReactNode
  /** Set false for a dialog whose work must not be abandoned halfway. */
  dismissible?: boolean
  children: ReactNode
  className?: string
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  dismissible = true,
  children,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEscapeKey(onClose, isOpen && dismissible)
  useFocusTrap(panelRef, isOpen)
  useLockBodyScroll(isOpen)

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
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
          'bg-surface shadow-overlay animate-pop-in relative flex max-h-[92vh] w-full flex-col',
          'rounded-t-2xl sm:rounded-2xl',
          widths[size],
          className,
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

        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="border-line bg-surface-sunken flex flex-wrap items-center justify-end gap-2 rounded-b-2xl border-t px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
