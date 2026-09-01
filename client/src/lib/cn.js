import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Joins class names and lets a later one win.
 *
 * `twMerge` is the part that matters: `cn('px-3', props.className)` must let a
 * caller pass `px-6` and actually get it, rather than shipping both and
 * leaving the winner to source order.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
