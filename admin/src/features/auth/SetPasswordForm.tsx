import { useState, type FormEvent } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { fieldErrorsOf, isApiError, messageOf } from '@/lib/api/errors'

/** The server's rule, repeated so the field can say it before a round trip. */
export const PASSWORD_MIN_LENGTH = 10

export interface SetPasswordFormProps {
  /** What the button says: "Set my password", "Choose a new password". */
  submitLabel: string
  onSubmit: (password: string) => Promise<void>
  onDone: () => void
}

/**
 * Choosing a password, for the two flows that do it from an emailed link.
 *
 * One component because accepting an invitation and completing a reset are the
 * same three seconds of a person's life: type it, type it again, be told
 * plainly if the shop will not accept it. The only difference is the wording on
 * the button and what happens next, and both are the caller's.
 *
 * ── Where the rules live ─────────────────────────────────────────────────────
 *
 * On the server. It refuses anything under ten characters, anything on a list
 * of common passwords, and anything containing the local part of the address —
 * and it answers `WEAK_PASSWORD` with a `details` array naming what was wrong.
 * Those sentences are shown as they arrive rather than replaced, because "is
 * too common; choose something less guessable" is actionable and "invalid
 * password" is not.
 *
 * The length check here is a courtesy that saves a round trip. It is not the
 * policy, and it deliberately does not try to be — a second copy of the rules
 * in the browser is a second copy to drift.
 */
export function SetPasswordForm({ submitLabel, onSubmit, onDone }: SetPasswordFormProps) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setFieldErrors({})

    const local: Record<string, string> = {}
    if (password.length < PASSWORD_MIN_LENGTH) {
      local.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`
    }
    // Checked here and nowhere else: the server never sees the confirmation,
    // because it is not part of the credential — it is a guard against a typo
    // in a field nobody can read back.
    if (confirmation !== password) local.confirmation = 'Both entries must match.'
    if (Object.keys(local).length > 0) {
      setFieldErrors(local)
      return
    }

    setIsSubmitting(true)
    try {
      await onSubmit(password)
      onDone()
    } catch (error) {
      // `WEAK_PASSWORD` arrives with a `details` array naming the field and the
      // reason; anything else is shown whole.
      const fields = fieldErrorsOf(error)
      if (Object.keys(fields).length > 0) setFieldErrors(fields)

      setFormError(
        isApiError(error) && error.code === 'RATE_LIMITED'
          ? 'Too many attempts. Wait a few minutes and try again.'
          : messageOf(error, 'That did not work.'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}

      <Field
        label="New password"
        error={fieldErrors.password}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. Avoid anything you use elsewhere.`}
        required
      >
        <Input
          type={revealed ? 'text' : 'password'}
          name="password"
          // `new-password`, so a password manager offers to generate one
          // instead of filling in the old one.
          autoComplete="new-password"
          autoFocus
          data-autofocus
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
              {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          }
        />
      </Field>

      <Field label="Confirm password" error={fieldErrors.confirmation} required>
        <Input
          type={revealed ? 'text' : 'password'}
          name="confirmation"
          autoComplete="new-password"
          placeholder="••••••••••••"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        isLoading={isSubmitting}
        leadingIcon={<Check className="size-4" />}
        className="mt-1"
      >
        {submitLabel}
      </Button>
    </form>
  )
}
