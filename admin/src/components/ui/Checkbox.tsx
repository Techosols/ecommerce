import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode
  description?: ReactNode
  /**
   * The third state: some of what this box stands for is selected.
   *
   * A prop rather than an attribute because `indeterminate` exists only as a
   * DOM property — React will not render it — so it has to be set on the node
   * itself. Without this the CSS below styles a state nothing can ever enter.
   */
  indeterminate?: boolean
}

/**
 * A checkbox whose tick is a sibling element rather than a background image.
 *
 * The obvious implementation paints the tick with `checked:bg-[url("data:…")]`,
 * and it is a trap: Tailwind cannot parse an arbitrary value containing spaces,
 * so the whole declaration is dropped and a *checked* box renders empty — the
 * worst possible failure for a control whose only job is to say yes or no.
 * Overlaying a real icon keeps the state visible and survives a class scan.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, indeterminate = false, ...props },
  ref,
) {
  // A callback ref so the property is set on every render the flag changes,
  // and the caller's own ref still gets the node.
  const attachRef = (node: HTMLInputElement | null) => {
    if (node) node.indeterminate = indeterminate
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  const control = (
    <span className="relative inline-flex size-4 shrink-0">
      <input
        ref={attachRef}
        type="checkbox"
        className={cn(
          'peer border-line-strong bg-surface size-4 cursor-pointer appearance-none rounded border',
          'checked:border-brand-600 checked:bg-brand-600',
          'indeterminate:border-brand-600 indeterminate:bg-brand-600',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'transition-colors',
          className,
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3.5}
        className="pointer-events-none absolute inset-0 m-auto size-3 text-white opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-0"
      />
      <Minus
        aria-hidden="true"
        strokeWidth={3.5}
        className="pointer-events-none absolute inset-0 m-auto size-3 text-white opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  )

  if (!label && !description) return control

  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span className="flex h-5 items-center">{control}</span>
      <span className="flex flex-col gap-0.5">
        {label ? <span className="text-ink text-sm leading-5">{label}</span> : null}
        {description ? <span className="text-muted text-xs">{description}</span> : null}
      </span>
    </label>
  )
})
