import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { AlertTriangle, Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api'
import { formatMoney, plural } from '@/lib/format'
import { EVENTS, track } from '@/lib/analytics'
import { useTrackOnce } from '@/lib/useTrack'
import { useCart } from '@/features/cart/hooks/cart.hooks'
import { useAuth } from '@/features/account/useAuth'
import { useStoreSettings } from '@/features/settings/useSettings'
import { AddressFields } from '../components/AddressFields'
import { emptyAddress, toAddressPayload, validateAddress } from '../address'
import { useCheckoutPreview, usePlaceOrder } from '../hooks/checkout.hooks'

/**
 * Checkout.
 *
 * The whole screen is arranged around one fact: **the shopper is never shown a
 * figure this browser worked out.** The subtotal, the delivery charge, the
 * discount, the tax and the total all come from `/checkout/preview`, which runs
 * the same rating, discounting and tax code that placing the order will run.
 * That is what makes it safe to promise the total.
 *
 * The quote is re-asked whenever the destination, the delivery choice, the
 * code or the payment method changes, because each of those changes the answer.
 * Everything else the shopper types — their name, their street — changes
 * nothing about the price and does not re-ask.
 */
export function CheckoutPage() {
  const cart = useCart()
  const settings = useStoreSettings()
  const { isSignedIn, isRestoring } = useAuth()

  // Reaching this page *is* starting checkout. Reported once the basket has
  // arrived, because a checkout with nothing in it is not one — and keyed on a
  // constant so re-quoting a delivery option does not start it again.
  useTrackOnce(EVENTS.CHECKOUT_STARTED, cart.data ? 'checkout' : null, {
    itemCount: cart.data?.totals?.itemCount,
    value: cart.data?.totals?.subtotal?.amount,
  })

  if (cart.isPending || isRestoring) return <CheckoutSkeleton />

  // Nothing to check out. Bounce rather than render a form over an empty
  // basket, which would only fail at the end.
  if (cart.data && cart.data.lines.length === 0) return <Navigate to="/cart" replace />

  /**
   * The shop can require an account to check out.
   *
   * The server refuses a guest checkout when that setting is off, so a form
   * rendered here would collect an address, a delivery choice and a payment
   * method and then fail at the very last step. Sending them to sign in first
   * — with the way back recorded — is the same rule enforced early rather than
   * a different one.
   *
   * This is not the security boundary. The server is, and it refuses
   * regardless of what this page decides to show.
   */
  if (settings && settings.guestCheckoutEnabled === false && !isSignedIn) {
    return <Navigate to="/sign-in?next=/checkout" replace />
  }

  return (
    <QueryBoundary
      isLoading={cart.isPending}
      error={cart.error}
      onRetry={() => void cart.refetch()}
      fallback={<CheckoutSkeleton />}
    >
      {cart.data ? <CheckoutForm cart={cart.data} /> : null}
    </QueryBoundary>
  )
}

function CheckoutForm({ cart }) {
  const navigate = useNavigate()
  const place = usePlaceOrder()

  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [address, setAddress] = useState(emptyAddress)
  const [billTo, setBillTo] = useState(emptyAddress)
  const [billsElsewhere, setBillsElsewhere] = useState(false)
  const [shippingMethodId, setShippingMethodId] = useState(null)
  const [paymentMethod, setPaymentMethod] = useState(null)
  const [code, setCode] = useState('')
  const [appliedCode, setAppliedCode] = useState(null)
  const [errors, setErrors] = useState({})

  // Minted once per mounted checkout: a retry after a dropped connection
  // replays the same attempt instead of placing a second order.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])

  const countryCode = address.countryCode.trim().toUpperCase()
  const preview = useCheckoutPreview({
    countryCode,
    shippingMethodId: shippingMethodId ?? undefined,
    discountCode: appliedCode ?? undefined,
    paymentMethod: paymentMethod ?? undefined,
  })

  const quote = preview.data
  const options = quote?.shippingOptions ?? []
  const methods = quote?.paymentMethods ?? []

  // The server picks a sensible default the first time; adopt it rather than
  // second-guessing which delivery option or method should be pre-selected.
  const chosenShipping = shippingMethodId ?? quote?.selectedShippingMethodId ?? null
  const chosenPayment = paymentMethod ?? quote?.selectedPaymentMethod ?? null

  const codeRejected = preview.error && appliedCode

  function applyCode() {
    setAppliedCode(code.trim() || null)
  }

  function clearCode() {
    setCode('')
    setAppliedCode(null)
  }

  function submit(event) {
    event.preventDefault()

    const found = validateAddress(address)
    if (!email.trim()) found.email = 'Required.'
    if (billsElsewhere) {
      const billing = validateAddress(billTo)
      for (const [key, message] of Object.entries(billing)) found[`billing-${key}`] = message
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return

    place.mutate(
      {
        idempotencyKey,
        body: {
          email: email.trim(),
          paymentMethod: chosenPayment ?? 'cod',
          phone: phone.trim() || null,
          shippingAddress: toAddressPayload(address, phone),
          ...(billsElsewhere ? { billingAddress: toAddressPayload(billTo, phone) } : {}),
          shippingMethodId: chosenShipping,
          discountCode: appliedCode,
          customerNote: note.trim() || null,
        },
      },
      {
        onSuccess: (order) => {
          // The one event the orders table cannot supply on its own: it ties
          // this purchase back to the visit that produced it, which is what
          // makes the funnel a funnel rather than two unrelated counts.
          track(EVENTS.CHECKOUT_COMPLETED, {
            orderId: order.id,
            value: order.totals?.total?.amount,
            currency: order.currency,
            paymentMethod: order.paymentMethod,
            itemCount: order.items?.length,
          })

          // By id, not by order number: the store's number prefix defaults to
          // "#", and `/orders/#1001` is a fragment, not a path. The order
          // itself is handed over in navigation state, so the confirmation
          // needs no second request — which matters most for a guest, for whom
          // this is the one moment they are guaranteed to see it.
          navigate(`/orders/${order.id}`, { replace: true, state: { order } })
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-8">
      <h1 className="text-3xl sm:text-4xl">Checkout</h1>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-4">
            <h2 className="text-xl">Where it goes</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label htmlFor="email" className="text-ink text-sm font-medium">
                  Email
                  <span className="text-bad ml-0.5" aria-hidden="true">
                    *
                  </span>
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className="border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none"
                  value={email}
                  disabled={place.isPending}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {errors.email ? (
                  <p className="text-bad text-xs font-medium">{errors.email}</p>
                ) : (
                  <p className="text-muted text-xs">Your confirmation goes here.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <label htmlFor="phone" className="text-ink text-sm font-medium">
                  Phone
                </label>
                <input
                  id="phone"
                  type="tel"
                  autoComplete="tel"
                  className="border-line bg-surface text-ink focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none"
                  value={phone}
                  disabled={place.isPending}
                  onChange={(event) => setPhone(event.target.value)}
                />
                <p className="text-muted text-xs">For the courier, if they need it.</p>
              </div>
            </div>

            <AddressFields
              prefix="ship"
              value={address}
              errors={errors}
              disabled={place.isPending}
              onChange={setAddress}
            />

            <label className="text-ink-soft flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={billsElsewhere}
                disabled={place.isPending}
                onChange={(event) => setBillsElsewhere(event.target.checked)}
                className="accent-brand-600 size-4"
              />
              Bill to a different address
            </label>

            {billsElsewhere ? (
              <div className="border-line flex flex-col gap-4 border-t pt-5">
                <h3 className="text-base font-semibold">Billing address</h3>
                <AddressFields
                  prefix="bill"
                  value={billTo}
                  errors={Object.fromEntries(
                    Object.entries(errors)
                      .filter(([key]) => key.startsWith('billing-'))
                      .map(([key, message]) => [key.replace('billing-', ''), message]),
                  )}
                  disabled={place.isPending}
                  onChange={setBillTo}
                />
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-xl">Delivery</h2>

            {!countryCode || countryCode.length !== 2 ? (
              <p className="text-muted text-sm">
                Enter a country above and the delivery options will appear.
              </p>
            ) : preview.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : options.length === 0 ? (
              <p className="border-warn/30 bg-warn-soft text-warn flex items-start gap-2 rounded-lg border px-4 py-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  We do not deliver to {countryCode} at the moment. Try another address, or get in
                  touch.
                </span>
              </p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Delivery option</legend>
                {options.map((option) => (
                  <label
                    key={option.id}
                    className={
                      option.id === chosenShipping
                        ? 'border-brand-600 bg-brand-50 flex cursor-pointer items-center gap-3 rounded-lg border p-3'
                        : 'border-line bg-surface hover:border-line-strong flex cursor-pointer items-center gap-3 rounded-lg border p-3'
                    }
                  >
                    <input
                      type="radio"
                      name="shipping"
                      className="accent-brand-600 size-4"
                      checked={option.id === chosenShipping}
                      disabled={place.isPending}
                      onChange={() => setShippingMethodId(option.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block text-sm font-medium">{option.name}</span>
                      {option.description || option.estimatedDaysMin !== null ? (
                        <span className="text-muted block text-xs">
                          {option.description ??
                            `${option.estimatedDaysMin}–${option.estimatedDaysMax} days`}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-ink tabular text-sm font-medium">
                      {option.price.amount === 0 ? 'Free' : formatMoney(option.price)}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </section>

          {methods.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-xl">Payment</h2>
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Payment method</legend>
                {methods.map((method) => (
                  <label
                    key={method.key}
                    className={
                      method.key === chosenPayment
                        ? 'border-brand-600 bg-brand-50 flex cursor-pointer items-center gap-3 rounded-lg border p-3'
                        : 'border-line bg-surface hover:border-line-strong flex cursor-pointer items-center gap-3 rounded-lg border p-3'
                    }
                  >
                    <input
                      type="radio"
                      name="payment"
                      className="accent-brand-600 size-4"
                      checked={method.key === chosenPayment}
                      disabled={place.isPending}
                      onChange={() => setPaymentMethod(method.key)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block text-sm font-medium">{method.label}</span>
                      <span className="text-muted block text-xs">{method.description}</span>
                    </span>
                    {method.fee.amount > 0 ? (
                      <span className="text-muted tabular text-sm">
                        +{formatMoney(method.fee)}
                      </span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="text-xl">Anything else</h2>
            <label htmlFor="note" className="sr-only">
              Note for the shop
            </label>
            <textarea
              id="note"
              rows={2}
              maxLength={1000}
              placeholder="Leave with the neighbour at number 12."
              className="border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              value={note}
              disabled={place.isPending}
              onChange={(event) => setNote(event.target.value)}
            />
          </section>
        </div>

        {/* ── The summary ─────────────────────────────────────────────────── */}
        <aside className="border-line bg-surface rounded-card sticky top-24 flex flex-col gap-4 border p-5">
          <h2 className="text-lg">Your order</h2>

          <ul className="divide-line divide-y text-sm">
            {cart.lines.map((line) => (
              <li key={line.variantId} className="flex items-start gap-3 py-2 first:pt-0">
                <span className="text-muted tabular w-6 shrink-0">{line.quantity}×</span>
                <span className="text-ink-soft min-w-0 flex-1">
                  {line.productTitle}
                  {line.variantTitle ? (
                    <span className="text-faint block text-xs">{line.variantTitle}</span>
                  ) : null}
                </span>
                <span className="text-ink tabular shrink-0">{formatMoney(line.lineTotal)}</span>
              </li>
            ))}
          </ul>

          <div className="border-line flex flex-col gap-2 border-t pt-4">
            <label htmlFor="code" className="text-ink text-sm font-medium">
              Discount code
            </label>
            <div className="flex gap-2">
              <input
                id="code"
                className="border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-9 w-full rounded-lg border px-3 text-sm uppercase focus:outline-none"
                placeholder="SUMMER25"
                value={code}
                disabled={place.isPending}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              {appliedCode ? (
                <Button size="sm" onClick={clearCode} disabled={place.isPending}>
                  Remove
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={applyCode}
                  disabled={place.isPending || !code.trim()}
                >
                  Apply
                </Button>
              )}
            </div>
            {/* The server's own refusal, verbatim — "that code has expired" is
                actionable in a way that "invalid coupon" is not. */}
            {codeRejected ? (
              <p className="text-bad text-xs font-medium">{messageOf(preview.error)}</p>
            ) : quote?.discount ? (
              <p className="text-good text-xs font-medium">
                {quote.discount.code} applied.
              </p>
            ) : null}
          </div>

          <div className="border-line flex flex-col gap-2 border-t pt-4">
            <Row label={plural(cart.totals.itemCount, 'item')} value={cart.totals.subtotal} />
            {quote ? (
              <>
                {quote.discountTotal.amount > 0 ? (
                  <Row label="Discount" value={quote.discountTotal} negative />
                ) : null}
                <Row label="Delivery" value={quote.shippingTotal} />
                {quote.paymentFee.amount > 0 ? (
                  <Row label="Payment fee" value={quote.paymentFee} />
                ) : null}
                <Row label="Tax" value={quote.taxTotal} />
                <div className="border-line mt-1 border-t pt-2">
                  <Row label="Total" value={quote.total} strong />
                </div>
              </>
            ) : (
              <p className="text-faint text-xs">
                Delivery and tax appear once you have entered a country.
              </p>
            )}
          </div>

          {place.error ? (
            <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
              {messageOf(place.error)}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            isLoading={place.isPending}
            disabled={!cart.purchasable || options.length === 0 || place.isPending}
          >
            {place.isPending ? 'Placing your order…' : 'Place order'}
          </Button>

          <p className="text-faint flex items-center justify-center gap-1.5 text-xs">
            <Lock className="size-3" aria-hidden="true" />
            Your basket is held while you pay.
          </p>

          <Link to="/cart" className="text-brand-600 text-center text-sm hover:underline">
            Back to the basket
          </Link>
        </aside>
      </div>
    </form>
  )
}

function Row({ label, value, strong, negative }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={strong ? 'text-ink text-sm font-semibold' : 'text-muted text-sm'}>
        {label}
      </span>
      <span
        className={
          strong
            ? 'text-ink tabular text-base font-semibold'
            : negative
              ? 'text-good tabular text-sm'
              : 'text-ink tabular text-sm'
        }
      >
        {negative ? '−' : ''}
        {formatMoney(value)}
      </span>
    </div>
  )
}

function CheckoutSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  )
}
