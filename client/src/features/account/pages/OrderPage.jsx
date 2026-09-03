import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { Banknote, CheckCircle2, Package } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatMoney } from '@/lib/format'
import { useAuth } from '../useAuth'
import { useMyOrder } from '../hooks/account.hooks'

/**
 * One order, for the person who placed it.
 *
 * Three ways somebody arrives here, and the screen handles each differently:
 *
 *   • **Straight from checkout.** The order is handed over in navigation state,
 *     so the confirmation appears instantly with no second request — and a
 *     guest sees the whole thing at the one moment they are guaranteed to.
 *   • **Signed in, from their orders.** Fetched by id against their session.
 *     The server matches on the owner, so asking for somebody else's id is a
 *     404 rather than a refusal that would confirm it exists.
 *   • **A guest, from an old link.** There is nothing to authenticate and no
 *     order number in the URL, so they are sent to the lookup, which asks for
 *     the number and the email together.
 */
export function OrderPage() {
  const { id } = useParams()
  const location = useLocation()
  const { isSignedIn, isRestoring } = useAuth()

  const handedOver = location.state?.order ?? null
  const query = useMyOrder(id, isSignedIn && !handedOver)

  if (handedOver) return <OrderView order={handedOver} justPlaced />
  if (isRestoring) return <Skeleton className="mx-auto h-96 w-full max-w-2xl" />
  if (!isSignedIn) return <Navigate to="/orders/lookup" replace />

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      fallback={<Skeleton className="mx-auto h-96 w-full max-w-2xl" />}
    >
      {query.data ? <OrderView order={query.data} /> : null}
    </QueryBoundary>
  )
}

const STATUS = {
  pending: { label: 'Placed', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  processing: { label: 'Being prepared', tone: 'good' },
  shipped: { label: 'On its way', tone: 'good' },
  delivered: { label: 'Delivered', tone: 'good' },
  completed: { label: 'Complete', tone: 'good' },
  returned: { label: 'Returned', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
}

export function OrderView({ order, justPlaced, actions }) {
  const status = STATUS[order.status] ?? { label: order.status, tone: 'neutral' }
  const shipping = order.addresses.find((address) => address.type === 'shipping')

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      {justPlaced ? (
        <div className="border-good/25 bg-good-soft rounded-card flex items-start gap-3 border px-5 py-4">
          <CheckCircle2 className="text-good mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-ink font-display text-lg">Thank you — your order is in</p>
            <p className="text-muted text-sm">
              We have emailed a confirmation to {order.email}. Keep the order number below.
            </p>
          </div>
        </div>
      ) : null}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl">Order {order.orderNumber}</h1>
          <p className="text-muted text-sm">
            Placed{' '}
            {new Date(order.placedAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>

      {order.cancelReason ? (
        <p className="border-bad/25 bg-bad-soft text-bad rounded-lg border px-4 py-3 text-sm">
          This order was cancelled. {order.cancelReason}
        </p>
      ) : null}

      <AwaitingBankTransfer order={order} />

      {order.paymentMethod === 'cod' && order.paymentState === 'awaiting_payment' ? (
        <p className="border-line text-muted rounded-card border border-dashed px-5 py-4 text-sm">
          You are paying cash on delivery. Have {formatMoney(order.totals.total)} ready when it
          arrives — there is nothing to pay now.
        </p>
      ) : null}

      <section className="border-line bg-surface rounded-card border">
        <h2 className="border-line border-b px-5 py-3 text-base font-semibold">What you ordered</h2>
        <ul className="divide-line divide-y">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-5 py-3">
              <span className="text-muted tabular w-8 shrink-0 text-sm">{item.quantity}×</span>
              <span className="min-w-0 flex-1">
                {/* A snapshot: the title and price as they were when it was
                    bought, not what the catalogue says today. */}
                <span className="text-ink block text-sm font-medium">{item.productTitle}</span>
                {item.variantTitle ? (
                  <span className="text-muted block text-xs">{item.variantTitle}</span>
                ) : null}
              </span>
              <span className="text-ink tabular shrink-0 text-sm">{formatMoney(item.total)}</span>
            </li>
          ))}
        </ul>

        <div className="border-line flex flex-col gap-2 border-t px-5 py-4 text-sm">
          <Row label="Items" value={order.totals.subtotal} />
          {order.discounts.map((discount) => (
            <Row
              key={discount.code}
              label={`Discount · ${discount.code}`}
              value={discount.amount}
              negative
            />
          ))}
          <Row label={order.shippingMethodName ?? 'Delivery'} value={order.totals.shippingTotal} />
          {order.totals.taxTotal.amount > 0 ? (
            <Row label="Tax" value={order.totals.taxTotal} />
          ) : null}
          <div className="border-line mt-1 border-t pt-2">
            <Row label="Total" value={order.totals.total} strong />
          </div>
          {order.totals.refundedTotal?.amount > 0 ? (
            <Row label="Refunded" value={order.totals.refundedTotal} negative />
          ) : null}
        </div>
      </section>

      {shipping ? (
        <section className="border-line bg-surface rounded-card border p-5">
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
            <Package className="text-muted size-4" aria-hidden="true" />
            Delivering to
          </h2>
          <address className="text-muted text-sm not-italic">
            {shipping.firstName} {shipping.lastName}
            <br />
            {shipping.company ? (
              <>
                {shipping.company}
                <br />
              </>
            ) : null}
            {shipping.line1}
            <br />
            {shipping.line2 ? (
              <>
                {shipping.line2}
                <br />
              </>
            ) : null}
            {[shipping.city, shipping.region, shipping.postalCode].filter(Boolean).join(', ')}
            <br />
            {shipping.countryCode}
          </address>
        </section>
      ) : null}

      {actions}

      <Link to="/products" className="text-brand-600 text-center text-sm hover:underline">
        Keep shopping
      </Link>
    </div>
  )
}

/**
 * The step the shopper still has to take.
 *
 * A bank-transfer order is placed unpaid and stays that way until somebody
 * sends money and a receipt — and the unpaid sweep will eventually cancel it.
 * The confirmation is the one moment a guest is guaranteed to be looking, so
 * this is where the next step has to be, in the strongest terms the page has.
 *
 * The link carries the order number and email so the payment page does not ask
 * for a credential the shopper is already holding.
 */
function AwaitingBankTransfer({ order }) {
  if (order.paymentMethod !== 'bank_transfer') return null
  if (order.paymentState !== 'awaiting_payment') return null
  if (order.status === 'cancelled') return null

  return (
    <section className="border-warn/30 bg-warn-soft rounded-card flex flex-wrap items-center justify-between gap-4 border px-5 py-4">
      <div className="flex items-start gap-3">
        <Banknote className="text-warn mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-ink font-medium">This order is waiting for your payment</p>
          <p className="text-muted text-sm">
            Send {formatMoney(order.totals.total)} to our account, then send us the receipt so we
            can confirm it.
          </p>
        </div>
      </div>
      <Link
        to={`/pay/bank-transfer?order=${encodeURIComponent(order.orderNumber)}&email=${encodeURIComponent(order.email)}`}
        className="bg-brand-600 hover:bg-brand-700 shadow-card inline-flex h-10 shrink-0 items-center rounded-lg px-4 text-sm text-white"
      >
        Pay now
      </Link>
    </section>
  )
}

function Row({ label, value, strong, negative }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={strong ? 'text-ink font-semibold' : 'text-muted'}>{label}</span>
      <span
        className={
          strong
            ? 'text-ink tabular font-semibold'
            : negative
              ? 'text-good tabular'
              : 'text-ink tabular'
        }
      >
        {negative ? '−' : ''}
        {formatMoney(value)}
      </span>
    </div>
  )
}
