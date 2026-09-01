import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { useAuth } from '../useAuth'

/**
 * Signing in, and creating an account.
 *
 * One screen with two modes rather than two screens: a shopper who came here
 * to check out does not care which of the two they need, and making them
 * navigate to find out loses the basket's momentum.
 *
 * Whatever the shop says about wrong credentials, it says the same thing for
 * every reason — unknown address, wrong password, disabled account. That is
 * the server's choice and it is the right one; this screen simply shows it.
 */
export function SignInPage({ mode = 'sign-in' }) {
  const { isSignedIn, isRestoring, signIn, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isRegister = mode === 'register'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const next = location.state?.from ?? '/account/orders'

  if (isRestoring) return <p className="text-muted py-16 text-center">Checking your session…</p>
  if (isSignedIn) return <Navigate to={next} replace />

  async function submit(event) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (isRegister) {
        await register({
          email: email.trim(),
          password,
          ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
          ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        })
      } else {
        await signIn(email.trim(), password)
      }
      navigate(next, { replace: true })
    } catch (thrown) {
      setError(thrown)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl">{isRegister ? 'Create an account' : 'Sign in'}</h1>
        <p className="text-muted text-sm">
          {isRegister
            ? 'It keeps your orders and addresses in one place.'
            : 'To see your orders and check out faster.'}
        </p>
      </header>

      <form onSubmit={submit} className="flex flex-col gap-4">
        {isRegister ? (
          <div className="grid grid-cols-2 gap-3">
            <Labelled id="firstName" label="First name">
              <input
                id="firstName"
                autoComplete="given-name"
                className={input}
                value={firstName}
                disabled={busy}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </Labelled>
            <Labelled id="lastName" label="Last name">
              <input
                id="lastName"
                autoComplete="family-name"
                className={input}
                value={lastName}
                disabled={busy}
                onChange={(event) => setLastName(event.target.value)}
              />
            </Labelled>
          </div>
        ) : null}

        <Labelled id="email" label="Email" required>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            className={input}
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Labelled>

        <Labelled
          id="password"
          label="Password"
          required
          hint={isRegister ? 'At least 10 characters.' : undefined}
        >
          <input
            id="password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            className={input}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Labelled>

        {/* Offered next to the field it is about, and only when signing in —
            somebody creating an account has no password to have forgotten. */}
        {!isRegister ? (
          <Link
            to="/forgot-password"
            className="text-brand-600 -mt-2 self-end text-sm hover:underline"
          >
            Forgotten your password?
          </Link>
        ) : null}

        {error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {messageOf(error)}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={busy}>
          {isRegister ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <p className="text-muted text-center text-sm">
        {isRegister ? (
          <>
            Already have an account?{' '}
            <Link to="/sign-in" className="text-brand-600 hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{' '}
            <Link to="/register" className="text-brand-600 hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>

      <p className="text-faint border-line border-t pt-4 text-center text-xs">
        You do not need an account to buy — you can check out as a guest.
      </p>
    </div>
  )
}

const input =
  'border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none disabled:opacity-60'

function Labelled({ id, label, required, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
        {required ? (
          <span className="text-bad ml-0.5" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? <p className="text-muted text-xs">{hint}</p> : null}
    </div>
  )
}
