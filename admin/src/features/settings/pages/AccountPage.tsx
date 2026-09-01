import { useState } from 'react'
import { Laptop, Smartphone } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import { describeAgent, isMobile } from '../components/sessionLabels'
import { useChangePassword, useRevokeSession, useSessions } from '../hooks/settings.hooks'
import type { Session } from '../types/settings.types'

/**
 * The operator's own account.
 *
 * Separate from Staff on purpose: everything here is about *you* and needs no
 * permission at all, while everything on Staff is about other people and needs
 * `staff:write`. A signed-in person who may not administer anybody can still
 * end a session on a laptop they left somewhere.
 */
export function AccountPage() {
  const { user } = useAuth()
  useDocumentTitle('Your account')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Your account"
        description={user ? `Signed in as ${user.email}` : 'Your sessions and your password.'}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SessionsCard />
        <PasswordCard />
      </div>
    </div>
  )
}

function SessionsCard() {
  const { toast } = useToast()
  const sessions = useSessions()
  const revoke = useRevokeSession()
  const [ending, setEnding] = useState<Session | null>(null)

  return (
    <Card>
      <CardHeader
        title="Where you are signed in"
        description="Every browser holding a live session for this account."
      />
      <CardBody>
        <QueryBoundary
          isLoading={sessions.isPending}
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        >
          <ul className="divide-line divide-y">
            {(sessions.data ?? []).map((session) => (
              <li key={session.id} className="flex items-center gap-3 py-3">
                <span className="text-muted shrink-0">
                  {isMobile(session.userAgent) ? (
                    <Smartphone className="size-4" />
                  ) : (
                    <Laptop className="size-4" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="text-ink flex flex-wrap items-center gap-2 text-sm font-medium">
                    {describeAgent(session.userAgent)}
                    {session.current ? (
                      <Badge size="sm" tone="positive">
                        This browser
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-faint block text-xs">
                    {session.ip ?? 'Unknown address'} · started{' '}
                    {formatRelativeTime(session.createdAt)} · expires{' '}
                    {formatDateTime(session.expiresAt)}
                  </span>
                </span>

                {/* The current session is ended by signing out, which also
                    clears the refresh cookie. Revoking it here would leave the
                    browser holding a cookie for a session that no longer
                    exists. */}
                {session.current ? null : (
                  <Button variant="ghost" size="sm" onClick={() => setEnding(session)}>
                    End
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </CardBody>

      <ConfirmDialog
        isOpen={ending !== null}
        onCancel={() => setEnding(null)}
        onConfirm={() => {
          if (!ending) return
          revoke.mutate(ending.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Session ended' })
              setEnding(null)
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not end it', description: messageOf(error) })
              setEnding(null)
            },
          })
        }}
        title="End this session?"
        confirmLabel="End the session"
        tone="danger"
        isLoading={revoke.isPending}
      >
        {ending ? describeAgent(ending.userAgent) : 'That browser'} is signed out immediately and
        has to sign in again.
      </ConfirmDialog>
    </Card>
  )
}

/** Mirrors `PASSWORD_MIN_LENGTH` in `server/src/shared/auth/password.ts`. */
const MIN_PASSWORD_LENGTH = 10

function PasswordCard() {
  const { toast } = useToast()
  const change = useChangePassword()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')

  const mismatch = confirm !== '' && next !== confirm
  const ready = current !== '' && next.length >= MIN_PASSWORD_LENGTH && !mismatch && confirm !== ''

  function submit() {
    if (!ready || change.isPending) return
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          toast({
            tone: 'success',
            title: 'Password changed',
            description: 'Every other session has been signed out.',
          })
          setCurrent('')
          setNext('')
          setConfirm('')
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not change it', description: messageOf(error) }),
      },
    )
  }

  return (
    <Card>
      <CardHeader title="Password" description="Changing it signs out every other browser." />
      <CardBody className="flex flex-col gap-4">
        <Field label="Current password" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>

        <Field
          label="New password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A phrase you can remember beats a short one you cannot.`}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>

        <Field
          label="Confirm new password"
          required
          error={mismatch ? 'These do not match.' : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        <Alert tone="info">
          This browser stays signed in. Every other session is ended, which is what makes changing a
          password worth doing after somebody else has seen it.
        </Alert>

        <div className="flex justify-end">
          <Button variant="primary" disabled={!ready} isLoading={change.isPending} onClick={submit}>
            Change password
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
