import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { useCancelGuestOrder, useOrderLookup } from '@/features/checkout/hooks/checkout.hooks'
import { ReturnRequest } from '../components/ReturnRequest'
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

  // Found: the same order view a signed-in customer gets, with the same
  // controls. A guest checkout is most of this shop's orders, and until now the
  // people who use it got a page they could only read.
  if (lookup.data) {
    return (
      <FoundOrder
        order={lookup.data}
        claim={{ orderNumber: lookup.data.orderNumber, email: email.trim() }}
      />
    )
  }

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

/**
 * The found order, with what its owner can still do to it.
 *
 * Which controls appear is decided the same way the signed-in page decides:
 * cancelling only while nothing has shipped, and returning only once something
 * has — and even then the server is asked what is returnable rather than being
 * told. Neither is inferred from the status vocabulary alone.
 */
function FoundOrder({ order, claim }) {
  const cancel = useCancelGuestOrder()
  const [confirming, setConfirming] = useState(false)

  const current = cancel.data ?? order
  const cancellable = current.status === 'pending' || current.status === 'confirmed'

  return (
    <OrderView
      order={current}
      actions={
        <>
          {!cancellable ? <ReturnRequest orderId={current.id} claim={claim} /> : null}

          {cancellable ? (
            <section className="border-line rounded-card border border-dashed p-5">
              <h2 className="text-ink mb-1 text-base font-semibold">Changed your mind?</h2>
              <p className="text-muted mb-3 text-sm">
                You can cancel while it is still being prepared. Once it is on its way, ask us for a
                return instead.
              </p>

              {cancel.error ? (
                <p className="border-bad/30 bg-bad-soft text-bad mb-3 rounded-lg border px-3 py-2 text-sm">
                  {messageOf(cancel.error)}
                </p>
              ) : null}

              {/* Never one click. Cancelling releases the stock and cannot be
                  undone from here — the shopper would have to order again. */}
              {confirming ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    isLoading={cancel.isPending}
                    onClick={() => cancel.mutate(claim)}
                  >
                    Yes, cancel it
                  </Button>
                  <Button onClick={() => setConfirming(false)} disabled={cancel.isPending}>
                    Keep the order
                  </Button>
                </div>
              ) : (
                <Button onClick={() => setConfirming(true)}>Cancel this order</Button>
              )}
            </section>
          ) : null}
        </>
      }
    />
  )
}

const input =
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none'
