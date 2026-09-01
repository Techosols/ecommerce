import { useState } from 'react'
import { BadgeCheck, Info, Mail } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api'
import { useAuth } from '../useAuth'
import { useProfile, useUpdateProfile } from '../hooks/profile.hooks'
import { useResendVerification } from '../hooks/security.hooks'

/**
 * Name, phone, and whether the shop may email you.
 *
 * The email address is shown and not editable, which is a deliberate design
 * decision on the server's part rather than a gap here: `PATCH /account` takes
 * a strict schema that does not include it, so sending one is a 422. Changing
 * the address somebody signs in with is an identity change, and doing it
 * without a verification round trip is how an account gets taken over by
 * whoever last had access to the session.
 *
 * Saying that plainly beats an input that looks editable and is refused.
 */
export function ProfilePage() {
  const { isSignedIn } = useAuth()
  const query = useProfile(isSignedIn)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl">Your details</h2>
        <p className="text-muted text-sm">What we call you, and how we reach you.</p>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="h-72 w-full" />}
      >
        {query.data ? <ProfileForm profile={query.data} /> : null}
      </QueryBoundary>
    </div>
  )
}

function ProfileForm({ profile }) {
  const update = useUpdateProfile()
  const resend = useResendVerification()

  const [firstName, setFirstName] = useState(profile.firstName ?? '')
  const [lastName, setLastName] = useState(profile.lastName ?? '')
  const [phone, setPhone] = useState(profile.phone ?? '')
  const [acceptsMarketing, setAcceptsMarketing] = useState(profile.acceptsMarketing ?? false)
  const [saved, setSaved] = useState(false)

  const blankToNull = (text) => (text.trim() === '' ? null : text.trim())

  function submit(event) {
    event.preventDefault()
    setSaved(false)
    update.mutate(
      {
        firstName: blankToNull(firstName),
        lastName: blankToNull(lastName),
        phone: blankToNull(phone),
        acceptsMarketing,
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form onSubmit={submit} className="flex max-w-lg flex-col gap-5">
      <div className="border-line bg-surface rounded-card flex flex-col gap-3 border p-5">
        <div className="flex items-start gap-3">
          <Mail className="text-muted mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-ink text-sm font-medium">{profile.email}</p>
            {profile.emailVerified ? (
              <p className="text-good flex items-center gap-1 text-xs">
                <BadgeCheck className="size-3.5" aria-hidden="true" />
                Verified
              </p>
            ) : (
              <div className="flex flex-col items-start gap-1.5">
                <p className="text-warn text-xs">Not verified yet.</p>
                {/* The server answers the same way whether or not the address
                    needs verifying, so this can only ever say it has asked. */}
                {resend.isSuccess ? (
                  <p className="text-muted text-xs">
                    If that address needs verifying, an email is on its way.
                  </p>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    isLoading={resend.isPending}
                    onClick={() => resend.mutate(profile.email)}
                  >
                    Send it again
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        <p className="text-faint border-line flex items-start gap-2 border-t pt-3 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Your email is how you sign in, so it cannot be changed here. Get in touch and we
          will move it for you.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="firstName" label="First name">
          <input
            id="firstName"
            autoComplete="given-name"
            maxLength={100}
            className={input}
            value={firstName}
            disabled={update.isPending}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </Field>
        <Field id="lastName" label="Last name">
          <input
            id="lastName"
            autoComplete="family-name"
            maxLength={100}
            className={input}
            value={lastName}
            disabled={update.isPending}
            onChange={(event) => setLastName(event.target.value)}
          />
        </Field>
      </div>

      <Field id="phone" label="Phone" hint="Only used if there is a problem with an order.">
        <input
          id="phone"
          type="tel"
          autoComplete="tel"
          maxLength={32}
          className={input}
          value={phone}
          disabled={update.isPending}
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>

      <label className="text-ink-soft flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acceptsMarketing}
          disabled={update.isPending}
          onChange={(event) => setAcceptsMarketing(event.target.checked)}
          className="accent-brand-600 mt-0.5 size-4"
        />
        <span>
          Email me about new things and offers.
          <span className="text-faint block text-xs">
            Order confirmations are sent either way — those are not marketing.
          </span>
        </span>
      </label>

      {update.error ? (
        <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
          {messageOf(update.error)}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" isLoading={update.isPending}>
          Save changes
        </Button>
        {saved && !update.isPending ? <p className="text-good text-sm">Saved.</p> : null}
      </div>
    </form>
  )
}

function Field({ id, label, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-muted text-xs">{hint}</p> : null}
    </div>
  )
}

const input =
  'border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none disabled:opacity-60'
