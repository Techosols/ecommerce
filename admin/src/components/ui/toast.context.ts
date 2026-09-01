import { createContext, useContext } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  description?: string
}

export interface ToastInput {
  tone?: ToastTone
  title: string
  description?: string
  /** Milliseconds; `null` keeps it until dismissed. Errors default to sticky. */
  duration?: number | null
}

export interface ToastContextValue {
  toast: (input: ToastInput) => string
  dismiss: (id: string) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside <ToastProvider>')
  return context
}
