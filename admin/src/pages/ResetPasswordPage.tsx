import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { authApi } from '@/features/auth/auth.api'
import { SetPasswordForm } from '@/features/auth/SetPasswordForm'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

/**
 * Completing a password reset.
 *
 * Reached from the link in the reset email, which the server points at this
 * origin for staff and at the shopfront for customers — same token, same
 * endpoint, different page to type into.
 *
 * ── What finishing this does elsewhere ───────────────────────────────────────
 *
 * Completing a reset revokes **every** session on the account and unlocks it if
 * it had been locked by failed attempts. That is the point of the flow: the
 * person doing this may be doing it because somebody else has their old
 * password. So the confirmation says so — otherwise being signed out on their
 * phone a moment later reads as a fault rather than as the thing they just
 * asked for.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [done, setDone] = useState(false)
  useDocumentTitle('Choose a new password')

  const token = params.get('token')

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="warning">
          This page needs the link from your reset email. Open that link, or ask for a new one.
        </Alert>
        <Link to="/forgot-password">
          <Button variant="secondary" fullWidth>
            Send me a new link
          </Button>
        </Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="positive" title="Password changed">
          You have been signed out everywhere else, on every device. Sign in with your new password.
        </Alert>
        <Button variant="primary" size="lg" fullWidth onClick={() => void navigate('/login')}>
          Sign in
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-ink text-base font-semibold">Choose a new password</h2>
        <p className="text-muted mt-1 text-sm">
          This signs you out everywhere else, which is what you want if somebody else knew the old
          one.
        </p>
      </div>

      <SetPasswordForm
        submitLabel="Change my password"
        onSubmit={(password) => authApi.resetPassword({ token, password })}
        onDone={() => setDone(true)}
      />

      <p className="text-faint text-center text-xs">
        Reset links work once and expire.{' '}
        <Link to="/forgot-password" className="hover:text-ink underline">
          Ask for another
        </Link>
        .
      </p>
    </div>
  )
}
