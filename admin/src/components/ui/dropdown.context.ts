import { createContext, useContext } from 'react'

export interface DropdownContextValue {
  close: () => void
}

export const DropdownContext = createContext<DropdownContextValue | null>(null)

/**
 * Closes the menu this component is inside.
 *
 * Exposed through context rather than a render prop so that anything nested in
 * the panel — a link, a form, a component three levels down — can dismiss it
 * without the menu's caller threading a callback down by hand.
 */
export function useDropdownClose(): () => void {
  return useContext(DropdownContext)?.close ?? (() => undefined)
}
