import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { authApi } from '@/features/auth/auth.api'
import { SetPasswordForm } from '@/features/auth/SetPasswordForm'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

/**
 * A colleague accepting their invitation.
 *
 * ── Why this page has to exist ───────────────────────────────────────────────
 *
 * An invited account is created with **no password at all** — that is
 * deliberate, so there is never a credential for somebody to type into a chat
 * window and hand over. The only way in is the single-use link in the
 * invitation email, and this is the page it points at
 * (`ADMIN_ORIGIN/accept-invitation?token=…`). Without it, inviting a colleague
 * produces an email whose link goes nowhere and an account nobody can sign in
 * to.
 *
 * ── The three states ─────────────────────────────────────────────────────────
 *
 * **No token** — somebody reached the page directly. It says so rather than
 * showing a form that cannot work.
 *
 * **A token** — the form. Whether it is valid is the server's answer, not this
 * page's: a token is opaque, and pre-checking it would mean a second endpoint
 * that tells strangers which tokens exist.
 *
 * **Done** — no session is issued, on purpose. The invitee signs in normally,
 * so there is exactly one login path in the whole application to reason about,
 * and it is the one that already gets everything right about staff checks and
 * refresh cookies.
 */
export function AcceptInvitationPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [done, setDone] = useState(false)
  useDocumentTitle('Accept your invitation')

  const token = params.get('token')

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="warning">
          This page needs the link from your invitation email. Open that link, and if it has
          expired, ask whoever invited you to send another.
        </Alert>
        <Link to="/login">
          <Button variant="secondary" fullWidth>
            Go to sign in
          </Button>
        </Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="positive">
          Your password is set. Sign in to get started.
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
        <h2 className="text-ink text-base font-semibold">Set your password</h2>
        <p className="text-muted mt-1 text-sm">
          You have been invited to the admin. Choose a password and you are in.
        </p>
      </div>

      <SetPasswordForm
        submitLabel="Set my password"
        onSubmit={(password) => authApi.acceptInvitation({ token, password }).then(() => undefined)}
        onDone={() => setDone(true)}
      />

      <p className="text-faint text-center text-xs">
        This link works once and expires. If it has already been used, ask for a new invitation.
      </p>
    </div>
  )
}
