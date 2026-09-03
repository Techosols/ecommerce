import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { authApi } from '@/features/auth/auth.api'
import { isApiError, messageOf } from '@/lib/api/errors'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

/**
 * Asking for a reset link.
 *
 * ── Why the answer is always the same ────────────────────────────────────────
 *
 * The server responds identically whether or not the address has an account,
 * and this page repeats that: "if there is an account, we have sent a link".
 * Saying "no such account" would turn a public form into a way to find out who
 * works here — and staff addresses are exactly what somebody probing a shop's
 * admin would want.
 *
 * So the confirmation deliberately promises nothing about whether an email is
 * on its way. It is the one place where being less helpful is the point.
 *
 * ── Where the link goes ──────────────────────────────────────────────────────
 *
 * The server picks the origin from the account's roles: staff are sent back
 * here, customers to the shopfront. One token, one endpoint, two pages that
 * collect the new password — because a colleague who follows a reset link and
 * lands on the storefront has been sent to the wrong application.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  useDocumentTitle('Reset your password')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setFieldError(null)

    if (!email.trim()) {
      setFieldError('Enter your email address.')
      return
    }

    setIsSubmitting(true)
    try {
      await authApi.requestPasswordReset(email.trim())
      setSent(true)
    } catch (error) {
      setFormError(
        isApiError(error) && error.code === 'RATE_LIMITED'
          ? 'Too many requests. Wait a few minutes and try again.'
          : messageOf(error, 'Could not send that.'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        {/* Careful wording. This says what was done, not what exists. */}
        <Alert tone="info" title="Check your inbox">
          If <span className="font-medium">{email.trim()}</span> has an account here, a link to
          choose a new password is on its way. It expires shortly, so use it soon.
        </Alert>
        <BackToSignIn />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-ink text-base font-semibold">Forgotten your password?</h2>
        <p className="text-muted mt-1 text-sm">
          Give us the address you sign in with and we will send you a link to set a new one.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {formError ? <Alert tone="danger">{formError}</Alert> : null}

        <Field label="Email address" error={fieldError ?? undefined} required>
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

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          isLoading={isSubmitting}
          leadingIcon={<Send className="size-4" />}
        >
          Send the link
        </Button>
      </form>

      <BackToSignIn />
    </div>
  )
}

function BackToSignIn() {
  return (
    <Link
      to="/login"
      className="text-muted hover:text-ink inline-flex items-center justify-center gap-1.5 text-sm"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back to sign in
    </Link>
  )
}
