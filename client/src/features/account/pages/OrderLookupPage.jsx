import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { useOrderLookup } from '@/features/checkout/hooks/checkout.hooks'
import { OrderView } from './OrderPage'

/**
 * A guest finding their own order again.
 *
 * Without this, a guest checkout is a one-way door: the confirmation is the
 * only time they ever see the order, and closing the tab loses it.
 *
 * It needs the order number **and** the email it was placed with. Order
 * numbers come from a sequence and are guessable, so the email is what makes
 * this safe to leave public — and the server answers every failure identically,
 * so it cannot be used to discover which numbers exist.
 */
export function OrderLookupPage() {
  const [orderNumber, setOrderNumber] = useState('')
  const [email, setEmail] = useState('')
  const lookup = useOrderLookup()

  if (lookup.data) return <OrderView order={lookup.data} />

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl">Find your order</h1>
        <p className="text-muted text-sm">
          The order number from your confirmation email, and the address it was sent to.
        </p>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          lookup.mutate({ orderNumber: orderNumber.trim(), email: email.trim() })
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="number" className="text-ink text-sm font-medium">
            Order number
          </label>
          <input
            id="number"
            required
            autoFocus
            placeholder="#1024"
            className={input}
            value={orderNumber}
            onChange={(event) => setOrderNumber(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-ink text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className={input}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        {lookup.error ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
            {messageOf(lookup.error)}
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={lookup.isPending}>
          Find it
        </Button>
      </form>

      <p className="text-faint text-center text-xs">
        Have an account?{' '}
        <Link to="/account/orders" className="text-brand-600 hover:underline">
          See all your orders
        </Link>
        .
      </p>
    </div>
  )
}

const input =
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none'
