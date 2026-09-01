import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useFieldControl } from './field.context'

/*
 * A field is an inset ring, not a border.
 *
 * Two reasons, and the second is the one that matters. A ring does not grow the
 * box, so a 32px input and a 32px button beside it are both 32px — with borders
 * one of them is 34. And a focused field can thicken its ring from 1px to 2px
 * without the control changing size and shoving its neighbours along the row.
 */
export const controlBase =
  'w-full rounded-control bg-surface text-ink placeholder:text-faint ' +
  'ring-1 ring-inset transition-shadow outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted ' +
  'read-only:bg-surface-sunken'

export const controlValid = 'ring-line-strong focus:ring-2 focus:ring-brand-600'
export const controlInvalid = 'ring-danger focus:ring-2 focus:ring-danger'

const sizes = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-8 px-3 text-[0.8125rem]',
  lg: 'h-10 px-3 text-sm',
} as const

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: keyof typeof sizes
  leadingIcon?: ReactNode
  trailingSlot?: ReactNode
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', leadingIcon, trailingSlot, invalid, className, ...props },
  ref,
) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false

  const control = (
    <input
      ref={ref}
      id={props.id ?? field?.id}
      aria-describedby={props['aria-describedby'] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={props.required ?? field?.required}
      className={cn(
        controlBase,
        isInvalid ? controlInvalid : controlValid,
        sizes[size],
        leadingIcon && 'pl-9',
        trailingSlot && 'pr-10',
        className,
      )}
      {...props}
    />
  )

  if (!leadingIcon && !trailingSlot) return control

  return (
    <div className="relative">
      {leadingIcon ? (
        <span
          aria-hidden="true"
          className="text-faint pointer-events-none absolute inset-y-0 left-3 flex items-center"
        >
          {leadingIcon}
        </span>
      ) : null}
      {control}
      {trailingSlot ? (
        <span className="absolute inset-y-0 right-1.5 flex items-center">{trailingSlot}</span>
      ) : null}
    </div>
  )
})
