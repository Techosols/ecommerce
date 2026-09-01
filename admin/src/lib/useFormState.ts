import { useCallback, useMemo, useState } from 'react'
import { fieldErrorsOf, isValidationError, messageOf } from '@/lib/api/errors'

export type FieldErrors<T> = Partial<Record<keyof T & string, string>>

export interface FormState<T extends Record<string, unknown>> {
  values: T
  /** Only the keys whose value differs from the loaded baseline. */
  dirty: Partial<T>
  isDirty: boolean
  errors: FieldErrors<T>
  /** A whole-form message: a conflict, a rate limit, a network failure. */
  formError: string | null
  setValue: <K extends keyof T & string>(key: K, value: T[K]) => void
  setValues: (patch: Partial<T>) => void
  /** Replaces the baseline as well, so a saved form is no longer dirty. */
  reset: (next?: T) => void
  setErrors: (errors: FieldErrors<T>) => void
  /** Maps an ApiError onto fields, returning true if anything matched a field. */
  applyServerError: (error: unknown, fallback?: string) => boolean
  clearErrors: () => void
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index])
  }
  return false
}

/**
 * Form state with a baseline, so a save can send only what changed.
 *
 * The baseline is the point. A PATCH built from every field would resend
 * values the operator never touched, and if someone else edited the product in
 * between, that resend silently reverts their work. Sending `dirty` means an
 * untouched field is absent from the request and therefore untouched on the
 * server.
 *
 * No form library: the admin's forms are flat objects of primitives, and this
 * is the whole of what they need. When something genuinely needs field arrays
 * and resolver schemas, that is the moment to add one.
 */
export function useFormState<T extends Record<string, unknown>>(initial: T): FormState<T> {
  const [values, setValuesState] = useState<T>(initial)
  const [errors, setErrorsState] = useState<FieldErrors<T>>({})
  const [formError, setFormError] = useState<string | null>(null)
  // State rather than a ref: the baseline is read during render to compute
  // `dirty`, and a ref read there is a value React has not promised is current.
  const [baseline, setBaseline] = useState<T>(initial)

  const setValue = useCallback(<K extends keyof T & string>(key: K, value: T[K]) => {
    setValuesState((current) => ({ ...current, [key]: value }))
    // Clearing on edit rather than on submit: an error that persists while the
    // operator is fixing it reads as though the fix did not register.
    setErrorsState((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }, [])

  const setValues = useCallback((patch: Partial<T>) => {
    setValuesState((current) => ({ ...current, ...patch }))
  }, [])

  const reset = useCallback(
    (next?: T) => {
      if (next) {
        setBaseline(next)
        setValuesState(next)
      } else {
        setValuesState(baseline)
      }
      setErrorsState({})
      setFormError(null)
    },
    [baseline],
  )

  const applyServerError = useCallback((error: unknown, fallback?: string) => {
    const fields = fieldErrorsOf(error) as FieldErrors<T>
    const matched = Object.keys(fields).length > 0

    setErrorsState(matched ? fields : {})
    // A validation error whose details all mapped to fields needs no banner —
    // the messages are already beside the inputs that caused them.
    setFormError(matched && isValidationError(error) ? null : messageOf(error, fallback))
    return matched
  }, [])

  const dirty = useMemo(() => {
    const changed: Partial<T> = {}
    for (const key of Object.keys(values) as Array<keyof T>) {
      if (!shallowEqual(values[key], baseline[key])) changed[key] = values[key]
    }
    return changed
  }, [values, baseline])

  return {
    values,
    dirty,
    isDirty: Object.keys(dirty).length > 0,
    errors,
    formError,
    setValue,
    setValues,
    reset,
    setErrors: setErrorsState,
    applyServerError,
    clearErrors: useCallback(() => {
      setErrorsState({})
      setFormError(null)
    }, []),
  }
}

/**
 * `Classic Burger` → `classic-burger`.
 *
 * A copy of the server's `slugify` in `catalogue/handles.ts`, used only to
 * *suggest* a handle as the operator types a title. The server generates its
 * own when the field is left blank and validates whatever is sent, so a drift
 * between the two costs a suggestion, never a wrong handle.
 */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Strip combining marks so "Caf\u00e9" becomes "cafe" rather than "caf".
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2019]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
      .replace(/-+$/g, '')
  )
}
