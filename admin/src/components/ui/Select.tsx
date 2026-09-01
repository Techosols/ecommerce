import { forwardRef, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useFieldControl } from './field.context'
import { controlBase, controlInvalid, controlValid } from './Input'

const sizes = {
  sm: 'h-8 pl-2.5 pr-8 text-xs',
  md: 'h-8 pl-3 pr-8 text-[0.8125rem]',
  lg: 'h-10 pl-3 pr-9 text-sm',
} as const

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: keyof typeof sizes
  invalid?: boolean
  options?: SelectOption[]
  /** Rendered as a disabled first option, for "choose one" placeholders. */
  placeholder?: string
}

/**
 * A native `<select>`, on purpose.
 *
 * A custom listbox is a large amount of keyboard and screen-reader work to
 * reimplement badly. Where the admin later needs search or multi-select, that
 * becomes its own component rather than a flag on this one.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', invalid, options, placeholder, className, children, ...props },
  ref,
) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false

  return (
    <div className="relative">
      <select
        ref={ref}
        id={props.id ?? field?.id}
        aria-describedby={props['aria-describedby'] ?? field?.describedBy}
        aria-invalid={isInvalid || undefined}
        required={props.required ?? field?.required}
        className={cn(
          controlBase,
          isInvalid ? controlInvalid : controlValid,
          sizes[size],
          'appearance-none',
          className,
        )}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="text-faint pointer-events-none absolute inset-y-0 right-3 my-auto size-4"
      />
    </div>
  )
})
