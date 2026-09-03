import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Banknote, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { messageOf } from '@/lib/api'
import { useAuth } from '@/features/account/useAuth'
import { BankDetails } from '../components/BankDetails'
import { ProofStatus } from '../components/ProofStatus'
import { ReceiptUpload } from '../components/ReceiptUpload'
import { useBankTransferDetails } from '../hooks/bankTransfer.hooks'

/**
 * Paying an order by bank transfer.
 *
 * ── Why this page exists at all ──────────────────────────────────────────────
 *
 * Choosing bank transfer at checkout leaves the order unpaid and pending, and
 * the unpaid sweep eventually cancels it. Everything that turns that into a
 * paid order happens here: the account to send to, and the receipt that gives a
 * member of staff something to match against a bank statement. Without this
 * page the method is a dead end that quietly expires.
 *
 * ── How somebody gets in ─────────────────────────────────────────────────────
 *
 * The order number and the email it was placed with — the pair the confirmation
 * page and the confirmation email both give them. Prefilled from the query
 * string when they arrive from their own order, typed in when they come back
 * later on a different device, which is the normal case for this method.
 *
 * A signed-in customer sends the same pair; the server matches on ownership
 * first. There is deliberately only one version of this flow.
 */
export function BankTransferPage() {
  const [params] = useSearchParams()
  const { isSignedIn } = useAuth()
  const [orderNumber, setOrderNumber] = useState(params.get('order') ?? '')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [justSent, setJustSent] = useState(false)

  const lookup = useBankTransferDetails()
  const claim = { orderNumber: orderNumber.trim(), email: email.trim() }

  // Arriving from an order page with both halves already in the link: ask
  // straight away rather than showing a form that is already filled in.
  const prefilled = Boolean(params.get('order') && params.get('email'))
  useEffect(() => {
    if (prefilled && lookup.isIdle) {
      lookup.mutate({ orderNumber: params.get('order').trim(), email: params.get('email').trim() })
    }
  }, [prefilled, lookup, params])

  if (!lookup.data) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
        <header className="flex flex-col items-center gap-2 text-center">
          <Banknote className="text-brand-600 size-7" aria-hidden="true" />
          <h1 className="text-3xl">Pay by bank transfer</h1>
          <p className="text-muted text-sm">
            The order number from your confirmation, and the address it was sent to.
          </p>
        </header>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            lookup.mutate(claim)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="order-number" className="text-ink text-sm font-medium">
              Order number
            </label>
            <input
              id="order-number"
              required
              autoFocus
              placeholder="#1024"
              className={input}
              value={orderNumber}
              onChange={(event) => setOrderNumber(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="order-email" className="text-ink text-sm font-medium">
              Email
            </label>
            <input
              id="order-email"
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
            Continue
          </Button>
        </form>

        <p className="text-faint text-center text-xs">
          {isSignedIn ? (
            <>
              Or find it under{' '}
              <Link to="/account/orders" className="text-brand-600 hover:underline">
                your orders
              </Link>
              .
            </>
          ) : (
            <>
              Paid a different way?{' '}
              <Link to="/orders/lookup" className="text-brand-600 hover:underline">
                Just look up your order
              </Link>
              .
            </>
          )}
        </p>
      </div>
    )
  }

  const { order, bankDetails, proofs } = lookup.data
  const waiting = proofs.some((proof) => proof.status === 'submitted')
  const paid = order.paymentStatus === 'paid'
  const cancelled = order.status === 'cancelled'

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl">Order {order.orderNumber}</h1>
          <p className="text-muted text-sm">Paying by bank transfer</p>
        </div>
        <Badge tone={paid ? 'good' : cancelled ? 'bad' : 'warn'}>
          {paid ? 'Paid' : cancelled ? 'Cancelled' : 'Awaiting payment'}
        </Badge>
      </header>

      {justSent ? (
        <div className="border-good/25 bg-good-soft rounded-card flex items-start gap-3 border px-5 py-4">
          <CheckCircle2 className="text-good mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-ink font-display text-lg">Thank you — we have your receipt</p>
            <p className="text-muted text-sm">
              Someone will check it against our bank statement and email you once your order is
              confirmed.
            </p>
          </div>
        </div>
      ) : null}

      {paid ? (
        <p className="border-good/25 bg-good-soft text-good rounded-lg border px-4 py-3 text-sm">
          This order is paid. There is nothing left to send.
        </p>
      ) : cancelled ? (
        <p className="border-bad/25 bg-bad-soft text-bad rounded-lg border px-4 py-3 text-sm">
          This order was cancelled, so it can no longer be paid. Please order again, or get in touch
          if you have already sent the money.
        </p>
      ) : null}

      <ProofStatus proofs={proofs} />

      {/* `bankDetails` is null when the shop has switched the method off since
          the order was placed, or when the order was never placed to be paid
          this way. Either way there is no account to show and no receipt to
          take — telling somebody to get in touch is the only honest answer. */}
      {!paid && !cancelled && bankDetails ? (
        <>
          <BankDetails
            bank={bankDetails}
            total={order.total}
            orderNumber={order.orderNumber}
          />

          {waiting ? (
            <p className="border-line text-muted rounded-card border border-dashed px-5 py-4 text-sm">
              Your receipt is with us and waiting to be checked. If something was wrong with it we
              will say so here, and you can send another.
            </p>
          ) : (
            <ReceiptUpload
              claim={claim.orderNumber ? claim : { orderNumber: order.orderNumber, email }}
              onSubmitted={() => {
                setJustSent(true)
                // Re-ask rather than patching the list here: the server owns
                // what counts as waiting, and one attempt can change the
                // order's payment status too.
                lookup.mutate(claim.orderNumber ? claim : { orderNumber: order.orderNumber, email })
              }}
            />
          )}
        </>
      ) : null}

      {!paid && !cancelled && !bankDetails ? (
        <p className="border-line text-muted rounded-card border border-dashed px-5 py-4 text-sm">
          This order cannot be paid by bank transfer. Please get in touch and we will sort it out.
        </p>
      ) : null}

      <Link to="/products" className="text-brand-600 text-center text-sm hover:underline">
        Keep shopping
      </Link>
    </div>
  )
}

const input =
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none'
