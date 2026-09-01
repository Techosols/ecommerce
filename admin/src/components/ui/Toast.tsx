import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ToastContext, type Toast, type ToastInput, type ToastTone } from './toast.context'

const tones: Record<ToastTone, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: 'text-info' },
  success: { icon: CheckCircle2, className: 'text-positive' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  error: { icon: XCircle, className: 'text-danger' },
}

/**
 * Transient feedback for actions the operator just took.
 *
 * Deliberately not a place to report a failed page load — that belongs in the
 * page, where it can be retried. Toasts are for "order confirmed", "note
 * saved", and errors that have nowhere else to appear.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const toast = useCallback(
    ({ tone = 'info', title, description, duration }: ToastInput) => {
      const id = crypto.randomUUID()
      setToasts((current) => [
        ...current.slice(-3),
        { id, tone, title, ...(description ? { description } : {}) },
      ])

      const ttl = duration === undefined ? (tone === 'error' ? null : 5000) : duration
      if (ttl !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ttl),
        )
      }
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-relevant="additions"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
        >
          {toasts.map((item) => {
            const { icon: Icon, className } = tones[item.tone]
            return (
              <div
                key={item.id}
                role={item.tone === 'error' ? 'alert' : 'status'}
                className="bg-surface-raised border-line shadow-overlay animate-slide-in-right pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-3.5"
              >
                <Icon aria-hidden="true" className={cn('mt-0.5 size-4.5 shrink-0', className)} />
                <div className="min-w-0 flex-1">
                  <p className="text-ink text-sm font-medium">{item.title}</p>
                  {item.description ? (
                    <p className="text-muted mt-0.5 text-xs">{item.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => dismiss(item.id)}
                  className="text-faint hover:text-ink -m-1 shrink-0 rounded p-1 transition-colors"
                >
                  <X className="size-4" />
                </button>
              </div>
            )
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
