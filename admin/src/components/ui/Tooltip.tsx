import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TooltipProps {
  label: ReactNode
  side?: 'top' | 'bottom' | 'right'
  children: ReactElement
  className?: string
}

const sides = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
} as const

/**
 * A hint for an icon-only control.
 *
 * It is never the only place information lives: icon buttons still carry an
 * `aria-label`, and a tooltip that appears on hover is unreachable by touch.
 */
export function Tooltip({ label, side = 'top', children, className }: TooltipProps) {
  const id = useId()
  const [visible, setVisible] = useState(false)

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => setVisible(true)}
      onBlurCapture={() => setVisible(false)}
    >
      {children}
      {visible ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'animate-fade-in pointer-events-none absolute z-50 rounded-md bg-slate-900 px-2 py-1',
            'text-xs font-medium whitespace-nowrap text-white shadow-md dark:bg-slate-700',
            sides[side],
            className,
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}
