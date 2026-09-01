import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * The tone vocabulary an operations screen needs.
 *
 * `neutral` is not a fallback for "unknown" — it means the state is fine and
 * uninteresting. Anything that needs an operator's attention gets `warning` or
 * `danger`, and nothing else should, or the colour stops meaning anything.
 */
const tones = {
  neutral: 'bg-surface-hover text-ink',
  brand: 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200',
  // `--color-*-soft` is the tint and `--color-*` the type, and both are
  // redefined for dark mode — a dark ground with pale type there, a pale ground
  // with dark type here. Neither needs an override at the component.
  positive: 'bg-positive-soft text-positive',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
} as const

/*
 * No ring. Shopify's badges are a tinted pill with dark type and no outline —
 * the tint alone carries the state, and a ring around every badge in a status
 * column adds a hundred hairlines to a page that is already dense.
 */
const sizes = {
  sm: 'px-2 py-0.5 text-[0.6875rem]',
  md: 'px-2 py-1 text-xs',
} as const

export type BadgeTone = keyof typeof tones

export interface BadgeProps {
  tone?: BadgeTone
  size?: keyof typeof sizes
  /** A filled dot before the label, for status columns scanned at a glance. */
  dot?: boolean
  className?: string
  children: ReactNode
}

export function Badge({
  tone = 'neutral',
  size = 'md',
  dot = false,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        tones[tone],
        sizes[size],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}
