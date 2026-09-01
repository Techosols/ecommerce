import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { useForgotPassword, useResetPassword } from '../hooks/security.hooks'

const MIN_LENGTH = 10

/**
 * "I have forgotten my password."
 *
 * The screen says the same thing whether or not the address has an account,
 * because the server answers the same 202 either way. That is not vagueness for
 * its own sake: an endpoint — or a form — that answered differently for a known
 * address would be a way to find out who shops here.
 *
 * So the confirmation is written to be true in both cases and useful in the one
 * that matters: check your inbox, and check the spelling if nothing arrives.
 */
export function ForgotPasswordPage() {
  const forgot = useForgotPassword()
  const [email, setEmail] = useState('')

  if (forgot.isSuccess) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 py-16 text-center">
        <MailCheck className="text-good size-10" aria-hidden="true" />
        <h1 className="text-2xl">Check your inbox</h1>
        <p className="text-muted text-sm">
          If there is an account for {email}, a link to set a new password is on its way. It
          is good for a short while, so use it soon.
        </p>
        <p className="text-faint text-xs">
          Nothing arrived? Check the spelling above, and your spam folder.
        </p>
        <Link to="/sign-in" className="text-brand-600 text-sm hover:underline">
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl">Forgotten your password?</h1>
        <p className="text-muted text-sm">
          Tell us the address you signed up with and we will send you a link.
        </p>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          forgot.mutate(email.trim())
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-ink text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoFocus
            autoComplete="email"
            className={input}
            value={email}
            disabled={forgot.isPending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        {forgot.error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {messageOf(forgot.error)}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={forgot.isPending}>
          Send me a link
        </Button>
      </form>

      <p className="text-faint text-center text-xs">
        Remembered it?{' '}
        <Link to="/sign-in" className="text-brand-600 hover:underline">
          Sign in
        </Link>
        .
      </p>
    </div>
  )
}

/**
 * Setting a new password from an emailed link.
 *
 * The token arrives in the query string and is never shown or stored — it is
 * read once and posted. Using it signs every other session out, which the
 * screen says before it happens rather than leaving somebody to discover it.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const reset = useResetPassword()

  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const tooShort = password.length > 0 && password.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== password
  const canSubmit = token && password.length >= MIN_LENGTH && confirm === password

  if (!token) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-2xl">That link is incomplete</h1>
        <p className="text-muted text-sm">
          Open the link from the email exactly as it was sent — some mail apps cut off the
          end of a long address.
        </p>
        <Link to="/forgot-password" className="text-brand-600 text-sm hover:underline">
          Ask for a new one
        </Link>
      </div>
    )
  }

  if (reset.isSuccess) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl">Password changed</h1>
        <p className="text-muted text-sm">
          You have been signed out everywhere else. Sign in with the new one.
        </p>
        <Button variant="primary" onClick={() => navigate('/sign-in', { replace: true })}>
          Sign in
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl">Set a new password</h1>
        <p className="text-muted text-sm">
          This will also sign you out anywhere else you are signed in.
        </p>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) reset.mutate({ token, password })
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-ink text-sm font-medium">
            New password
          </label>
          <input
            id="password"
            type="password"
            required
            autoFocus
            autoComplete="new-password"
            className={input}
            value={password}
            disabled={reset.isPending}
            onChange={(event) => setPassword(event.target.value)}
          />
          {tooShort ? (
            <p className="text-bad text-xs font-medium">At least {MIN_LENGTH} characters.</p>
          ) : (
            <p className="text-muted text-xs">At least {MIN_LENGTH} characters.</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="confirm" className="text-ink text-sm font-medium">
            Again, to be sure
          </label>
          <input
            id="confirm"
            type="password"
            required
            autoComplete="new-password"
            className={input}
            value={confirm}
            disabled={reset.isPending}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? (
            <p className="text-bad text-xs font-medium">These two do not match.</p>
          ) : null}
        </div>

        {reset.error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {messageOf(reset.error)}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          isLoading={reset.isPending}
          disabled={!canSubmit || reset.isPending}
        >
          Set the new password
        </Button>
      </form>
    </div>
  )
}

const input =
  'border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none disabled:opacity-60'
