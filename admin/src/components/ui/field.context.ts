import { createContext, useContext } from 'react'

/**
 * The id, `aria-describedby` and `aria-invalid` for one form control.
 *
 * Derived once by `<Field>` and handed to the control through context, because
 * those three are exactly what gets forgotten when each input wires its own
 * accessibility.
 */
export interface FieldContextValue {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

export const FieldContext = createContext<FieldContextValue | null>(null)

export function useFieldControl(): FieldContextValue | null {
  return useContext(FieldContext)
}
