import { useLocation, useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { LoginForm } from '@/features/auth/LoginForm'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

const endedMessages = {
  expired: 'Your session ended. Sign in again to continue.',
  'signed-out': 'You have been signed out.',
  'not-staff': 'That account does not have access to the admin.',
} as const

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { endedReason } = useAuth()
  useDocumentTitle('Sign in')

  const from = (location.state as { from?: string } | null)?.from

  return (
    <div className="flex flex-col gap-4">
      {endedReason ? (
        <Alert tone={endedReason === 'not-staff' ? 'danger' : 'info'}>
          {endedMessages[endedReason]}
        </Alert>
      ) : null}

      <LoginForm
        onSuccess={() => {
          // Back to wherever the guard interrupted them, so a bookmarked deep
          // link survives an expired session.
          void navigate(from ?? '/dashboard', { replace: true })
        }}
      />
    </div>
  )
}
