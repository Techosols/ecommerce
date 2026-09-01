import { Link } from 'react-router-dom'
import { FileQuestion, Lock, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { StatePanel } from './StatePanel'

const linkButton =
  'bg-surface text-ink border-line-strong hover:bg-surface-hover shadow-card inline-flex h-9.5 items-center rounded-lg border px-3.5 text-sm font-medium'

/**
 * Not signed in.
 *
 * Reached when a session ends while a page is open rather than on first load —
 * a cold visit is redirected to `/login` by the route guard before anything
 * renders.
 */
export function UnauthorizedState({ variant = 'page' }: { variant?: 'inline' | 'page' }) {
  return (
    <StatePanel
      tone="warning"
      icon={<Lock className="size-5" />}
      title="Your session has ended"
      description="Sign in again to continue. Nothing you have already saved is affected."
      actions={
        <Button variant="primary" onClick={() => window.location.assign('/login')}>
          Sign in
        </Button>
      }
      variant={variant}
    />
  )
}

/**
 * Signed in, but this is not yours to see.
 *
 * The wording avoids naming the missing permission: an operator cannot grant it
 * to themselves, so the useful next step is their administrator, not a code.
 */
export function ForbiddenState({
  variant = 'page',
  resource,
}: {
  variant?: 'inline' | 'page'
  resource?: string
}) {
  return (
    <StatePanel
      tone="danger"
      icon={<ShieldAlert className="size-5" />}
      title="You do not have access to this"
      description={
        resource
          ? `Your account is not permitted to view ${resource}. Ask an administrator if you need it.`
          : 'Your account is not permitted to view this area. Ask an administrator if you need access.'
      }
      actions={
        <Link to="/dashboard" className={linkButton}>
          Back to dashboard
        </Link>
      }
      variant={variant}
    />
  )
}

export function NotFoundState({ variant = 'page' }: { variant?: 'inline' | 'page' }) {
  return (
    <StatePanel
      icon={<FileQuestion className="size-5" />}
      title="Page not found"
      description="That address does not match anything in the admin."
      actions={
        <Link to="/dashboard" className={linkButton}>
          Back to dashboard
        </Link>
      }
      variant={variant}
    />
  )
}
