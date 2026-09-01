import { useState } from 'react'
import { Laptop, LogOut, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api'
import { securityApi } from '../api/security.api'
import { useAuth } from '../useAuth'
import { useChangePassword, useRevokeSession, useSessions } from '../hooks/security.hooks'

/** The server's own minimum. Said up front rather than after a refusal. */
const MIN_LENGTH = 10

/**
 * Password and signed-in devices.
 *
 * The two halves belong together because they are what somebody opens when
 * they think another person has their account: change the password, then throw
 * that person out. Splitting them across two screens means doing half of it.
 *
 * Changing the password keeps *this* session and revokes the others, which is
 * the server's behaviour and the right one — being signed out of the browser
 * you are currently fixing things in is a poor reward for fixing them.
 */
export function SecurityPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl">Security</h2>
        <p className="text-muted text-sm">Your password, and where you are signed in.</p>
      </div>

      <ChangePassword />
      <Sessions />
    </div>
  )
}

function ChangePassword() {
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)

  // Checked here only so somebody is told at the field rather than by a 422
  // after pressing the button. The server checks the same things and its
  // answer is the one that counts.
  const tooShort = next.length > 0 && next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit = current && next.length >= MIN_LENGTH && confirm === next

  function submit(event) {
    event.preventDefault()
    if (!canSubmit) return
    setDone(false)
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setDone(true)
          setCurrent('')
          setNext('')
          setConfirm('')
        },
      },
    )
  }

  return (
    <section className="border-line bg-surface rounded-card flex max-w-md flex-col gap-4 border p-5">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <ShieldCheck className="text-muted size-4" aria-hidden="true" />
        Change your password
      </h3>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="current" label="Current password">
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            className={input}
            value={current}
            disabled={change.isPending}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>

        <Field
          id="next"
          label="New password"
          hint={`At least ${MIN_LENGTH} characters.`}
          error={tooShort ? `At least ${MIN_LENGTH} characters.` : null}
        >
          <input
            id="next"
            type="password"
            autoComplete="new-password"
            className={input}
            value={next}
            disabled={change.isPending}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>

        <Field
          id="confirm"
          label="New password again"
          error={mismatch ? 'These two do not match.' : null}
        >
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className={input}
            value={confirm}
            disabled={change.isPending}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        {change.error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {messageOf(change.error)}
          </p>
        ) : null}

        {done ? (
          <p className="border-good/30 bg-good-soft text-good rounded-lg border px-3 py-2 text-sm">
            Password changed. Everywhere else you were signed in has been signed out.
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          isLoading={change.isPending}
          disabled={!canSubmit || change.isPending}
        >
          Change password
        </Button>
      </form>
    </section>
  )
}

/**
 * How many sessions to show before asking.
 *
 * `GET /auth/sessions` returns every active session as one unpaginated array —
 * fine for a person with three devices, and an endless wall for anyone who
 * signs in from a new browser often. Capping the *display* is a presentation
 * choice this screen is allowed to make; it does not hide anything, since the
 * count and the toggle say exactly how many there are.
 */
const VISIBLE_SESSIONS = 6

function Sessions() {
  const { isSignedIn, signOut } = useAuth()
  const query = useSessions(isSignedIn)
  const revoke = useRevokeSession()
  const [ending, setEnding] = useState(false)
  const [showAll, setShowAll] = useState(false)

  /**
   * Ends every session, this one included — so the browser must be signed out
   * afterwards rather than left holding a token the server has forgotten.
   */
  async function everywhere() {
    setEnding(true)
    try {
      await securityApi.signOutEverywhere()
    } finally {
      await signOut()
    }
  }

  // This device first, then newest — so the one somebody is looking for is not
  // buried under a month of old sign-ins.
  const all = [...(query.data ?? [])].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return new Date(b.createdAt) - new Date(a.createdAt)
  })
  const shown = showAll ? all : all.slice(0, VISIBLE_SESSIONS)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          Where you are signed in
          {all.length > 0 ? (
            <span className="text-muted ml-2 text-sm font-normal">
              {all.length} {all.length === 1 ? 'session' : 'sessions'}
            </span>
          ) : null}
        </h3>
        <Button
          size="sm"
          isLoading={ending}
          leadingIcon={<LogOut className="size-3.5" aria-hidden="true" />}
          onClick={() => void everywhere()}
        >
          Sign out everywhere
        </Button>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="h-32 w-full" />}
      >
        <ul className="border-line bg-surface rounded-card divide-line divide-y border">
          {shown.map((session) => (
            <li key={session.id} className="flex items-center gap-3 px-4 py-3">
              <Laptop className="text-faint size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-sm">
                  {describeAgent(session.userAgent)}
                  {session.current ? (
                    <span className="text-good ml-2 text-xs font-medium">This device</span>
                  ) : null}
                </p>
                <p className="text-muted text-xs">
                  {session.ip ? `${session.ip} · ` : ''}
                  since{' '}
                  {new Date(session.createdAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
              </div>

              {!session.current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Sign out ${describeAgent(session.userAgent)}`}
                  isLoading={revoke.isPending}
                  onClick={() => revoke.mutate(session.id)}
                >
                  Sign out
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {all.length > shown.length ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-brand-600 mt-2 text-sm hover:underline"
          >
            Show the other {all.length - shown.length}
          </button>
        ) : null}
      </QueryBoundary>

      {revoke.error ? <p className="text-bad text-sm">{messageOf(revoke.error)}</p> : null}
    </section>
  )
}

/**
 * A user-agent string turned into something a person recognises.
 *
 * Deliberately crude, and it stops well short of guessing: anything it does not
 * know is "Another browser" rather than a wrong confident answer. The point is
 * to help somebody spot the session that is not theirs, and "Chrome on Windows"
 * does that where 180 characters of tokens does not.
 */
function describeAgent(agent) {
  if (!agent) return 'Unknown device'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Safari\//.test(agent) && !/Chrome\//.test(agent)
        ? 'Safari'
        : /Firefox\//.test(agent)
          ? 'Firefox'
          : null
  const platform = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Macintosh/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : null

  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Another browser'
}

function Field({ id, label, hint, error, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-bad text-xs font-medium">{error}</p>
      ) : hint ? (
        <p className="text-muted text-xs">{hint}</p>
      ) : null}
    </div>
  )
}

const input =
  'border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none disabled:opacity-60'
