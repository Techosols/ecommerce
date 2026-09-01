import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

const variants = {
  primary: 'bg-brand-600 text-white shadow-card hover:bg-brand-700 active:bg-brand-900 disabled:bg-brand-300',
  secondary: 'bg-surface text-ink border border-line-strong shadow-card hover:bg-sunken',
  ghost: 'text-ink-soft hover:bg-sunken hover:text-ink',
  copper: 'bg-copper-500 text-white shadow-card hover:bg-copper-600',
}

const sizes = {
  sm: 'h-8 rounded-md px-3 text-sm gap-1.5',
  md: 'h-10 rounded-lg px-4 text-sm gap-2',
  lg: 'h-12 rounded-lg px-6 text-base gap-2',
}

/**
 * A square button holding nothing but an icon. Same heights as above, so a row
 * of mixed buttons still lines up; the horizontal padding goes, because a
 * 16px glyph in 16px of padding reads as a mis-click target rather than a
 * control.
 */
const iconSizes = {
  sm: 'h-8 w-8 rounded-md p-0',
  md: 'h-10 w-10 rounded-lg p-0',
  lg: 'h-12 w-12 rounded-lg p-0',
}

/**
 * Every button in the shop.
 *
 * The default is `secondary` on purpose: a page with three primary buttons has
 * no primary button, so the emphatic one has to be asked for by name.
 */
export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    isLoading = false,
    fullWidth = false,
    // An icon-only button carries no text, so `aria-label` is not optional —
    // the caller supplies it, and without one the control is unreachable to a
    // screen reader.
    iconOnly = false,
    leadingIcon,
    className,
    disabled,
    type = 'button',
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // A loading button must not be pressable, but it must still be
      // focusable and still announce itself — hence `aria-busy` rather than
      // swapping the label out for a spinner.
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,color,box-shadow] duration-150',
        'disabled:pointer-events-none disabled:opacity-60',
        variants[variant],
        iconOnly ? iconSizes[size] : sizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {isLoading ? (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        leadingIcon
      )}
      {children}
    </button>
  )
})
