import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { FieldContext } from './field.context'

export interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  /** A string turns the field red and is announced; `undefined` means valid. */
  error?: string | undefined
  required?: boolean
  className?: string
  children: ReactNode
}

export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label ? (
          <label htmlFor={id} className="text-ink text-sm font-medium">
            {label}
            {required ? (
              <span className="text-danger ml-0.5" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
        ) : null}

        {children}

        {hint && !error ? (
          <p id={hintId} className="text-muted text-xs">
            {hint}
          </p>
        ) : null}

        {error ? (
          <p id={errorId} className="text-danger text-xs font-medium">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}
