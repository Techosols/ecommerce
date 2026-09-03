import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, LogIn } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { fieldErrorsOf, isApiError, messageOf } from '@/lib/api/errors'
import { useAuth } from './useAuth'

export interface LoginFormProps {
  onSuccess: () => void
}

/**
 * The one place credentials are typed.
 *
 * Client-side validation here is a courtesy — it saves a round trip on an empty
 * field. The server validates the same input with a strict schema and is the
 * only thing that decides whether a login succeeds.
 *
 * Failure messages are deliberately not more specific than the server's:
 * `INVALID_CREDENTIALS` covers an unknown address, a wrong password, a disabled
 * account and a locked one, precisely so the form cannot be used to discover
 * which addresses have accounts.
 */
export function LoginForm({ onSuccess }: LoginFormProps) {
  const { login } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setFieldErrors({})

    const localErrors: Record<string, string> = {}
    if (!email.trim()) localErrors.email = 'Enter your email address.'
    if (!password) localErrors.password = 'Enter your password.'
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors)
      return
    }

    setIsSubmitting(true)
    try {
      await login({ email: email.trim(), password })
      onSuccess()
    } catch (error) {
      const fields = fieldErrorsOf(error)
      if (Object.keys(fields).length > 0) setFieldErrors(fields)

      setFormError(
        isApiError(error) && error.code === 'RATE_LIMITED'
          ? 'Too many attempts. Wait a few minutes and try again.'
          : messageOf(error, 'Could not sign you in.'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}

      <Field label="Email address" error={fieldErrors.email} required>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          data-autofocus
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Field label="Password" error={fieldErrors.password} required>
        <Input
          type={revealed ? 'text' : 'password'}
          name="password"
          autoComplete="current-password"
          placeholder="••••••••••••"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          trailingSlot={
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={revealed ? 'Hide password' : 'Show password'}
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff className="size-4 dark:text-white" /> : <Eye className="size-4 dark:text-white" />}
            </Button>
          }
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        isLoading={isSubmitting}
        leadingIcon={<LogIn className="size-4" />}
        className="mt-1"
      >
        Sign in
      </Button>
    </form>
  )
}
