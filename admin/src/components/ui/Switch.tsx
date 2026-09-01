import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** Required unless the switch sits inside a `<label>`. */
  label?: string
  id?: string
  className?: string
}

/**
 * A toggle for a setting that takes effect immediately.
 *
 * Anything that needs a Save button is a Checkbox instead — the affordance
 * should tell the operator whether their change has already happened.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  id,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors',
        checked ? 'bg-brand-600' : 'bg-line-strong',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-4 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}
