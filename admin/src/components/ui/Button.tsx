import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './Spinner'

/**
 * Five intents, and each says something different about the action:
 *
 *   primary   the one thing this screen is for
 *   secondary a real action that is not the main one
 *   subtle    a filled but quiet action, for toolbars
 *   ghost     navigation and icon affordances
 *   danger    destructive and irreversible — refunds, cancellations, deletes
 *
 * `danger` is a separate intent rather than a colour prop so that a destructive
 * button is impossible to build by accident and easy to find by grep.
 *
 * ── Why the primary button is near-black ────────────────────────────────────
 *
 * Because Shopify's is, and for a reason worth keeping: an operations screen
 * has one primary action and a great many coloured status signals. A blue Save
 * competes with every "Active" badge and every link on the page; a black one
 * reads as *the button* without spending any of the colour vocabulary that
 * status needs.
 *
 * The borders are drawn with an inset ring rather than a real border so a
 * button and an input of the same size line up: a 1px border grows the box,
 * `inset` does not.
 */
const variants = {
  primary:
    'bg-ink text-white shadow-card hover:bg-ink/90 active:bg-black disabled:bg-faint',
  secondary:
    'bg-surface text-ink shadow-card ring-1 ring-line-strong ring-inset hover:bg-surface-hover active:bg-surface-sunken',
  subtle: 'bg-surface-sunken text-ink hover:bg-surface-hover active:bg-line',
  ghost: 'text-ink-soft hover:bg-surface-hover hover:text-ink active:bg-surface-sunken',
  danger:
    'bg-danger text-white shadow-card hover:brightness-110 active:brightness-95 disabled:opacity-50',
} as const

/*
 * Shopify's control heights: 28 / 32 / 32 / 40. `md` is deliberately the same
 * height as `sm` and differs only in padding — the admin has one control
 * height, and a page whose buttons are three different heights reads as three
 * different apps.
 */
const sizes = {
  xs: 'h-7 rounded-control px-2 text-xs',
  sm: 'h-8 rounded-control px-3 text-xs',
  md: 'h-8 rounded-control px-3 text-[0.8125rem]',
  lg: 'h-10 rounded-control px-4 text-sm',
} as const

const gaps = {
  xs: 'gap-1',
  sm: 'gap-1.5',
  md: 'gap-1.5',
  lg: 'gap-2',
} as const

const iconSizes = {
  xs: 'size-7 rounded-control',
  sm: 'size-8 rounded-control',
  md: 'size-8 rounded-control',
  lg: 'size-10 rounded-control',
} as const

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  /** Renders a square button; `aria-label` becomes required in practice. */
  iconOnly?: boolean
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  isLoading?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  fullWidth?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    iconOnly = false,
    isLoading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
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
      disabled={disabled ?? isLoading}
      aria-busy={isLoading || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,color,box-shadow,opacity] duration-150',
        'disabled:pointer-events-none disabled:opacity-60',
        variants[variant],
        iconOnly ? iconSizes[size] : sizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {isLoading ? (
        <Spinner
          size={size === 'lg' ? 'md' : 'sm'}
          label={null}
          className="absolute inset-0 m-auto items-center justify-center"
        />
      ) : null}
      <span className={cn('inline-flex items-center', gaps[size], isLoading && 'invisible')}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
    </button>
  )
})
