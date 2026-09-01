import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { useFieldControl } from './field.context'
import { controlBase, controlInvalid, controlValid } from './Input'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 4, ...props },
  ref,
) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false

  return (
    <textarea
      ref={ref}
      rows={rows}
      id={props.id ?? field?.id}
      aria-describedby={props['aria-describedby'] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={props.required ?? field?.required}
      className={cn(
        controlBase,
        isInvalid ? controlInvalid : controlValid,
        'resize-y px-3 py-2 text-sm leading-relaxed',
        className,
      )}
      {...props}
    />
  )
})
