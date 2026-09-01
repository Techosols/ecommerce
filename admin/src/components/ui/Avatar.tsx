import { cn } from '@/lib/cn'

const sizes = {
  sm: 'size-7 text-[0.6875rem]',
  md: 'size-9 text-xs',
  lg: 'size-11 text-sm',
} as const

export interface AvatarProps {
  initials: string
  size?: keyof typeof sizes
  className?: string
}

/**
 * Initials, not photographs. Staff accounts have no avatar upload and inventing
 * a placeholder face for an operations tool is noise.
 */
export function Avatar({ initials, size = 'md', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-brand-100 text-brand-700 dark:bg-brand-900 dark:text-brand-200',
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        sizes[size],
        className,
      )}
    >
      {initials}
    </span>
  )
}
