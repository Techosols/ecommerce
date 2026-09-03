import { Link } from 'react-router-dom'
import { AlertTriangle, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatMoney, plural } from '@/lib/format'
import { messageOf } from '@/lib/api'
import { EVENTS } from '@/lib/analytics'
import { useTrackOnce } from '@/lib/useTrack'
import { useCart, useRemoveFromCart, useSetCartQuantity } from '../hooks/cart.hooks'

/**
 * The basket.
 *
 * Every figure is the server's, re-resolved on this request. That is what
 * makes the warning below possible: a line that has gone out of stock or been
 * withdrawn since it was added is shown, marked, and blocks checkout — rather
 * than being silently dropped or quietly failing at the till.
 *
 * Delivery and tax are deliberately absent. Neither can be known before an
 * address exists, and inventing a figure here that checkout would then
 * contradict is worse than saying so.
 */
export function CartPage() {
  const query = useCart()

  // Once per visit to the basket, not once per quantity change: keyed on a
  // constant so editing a line does not report a second view.
  useTrackOnce(EVENTS.CART_VIEWED, query.data ? 'cart' : null, {
    itemCount: query.data?.totals?.itemCount,
    value: query.data?.totals?.subtotal?.amount,
  })

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl sm:text-4xl">Your basket</h1>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<CartSkeleton />}
      >
        {query.data ? <CartView cart={query.data} /> : null}
      </QueryBoundary>
    </div>
  )
}

function CartView({ cart }) {
  const setQuantity = useSetCartQuantity()
  const remove = useRemoveFromCart()
  const isSaving = setQuantity.isPending || remove.isPending
  const failure = setQuantity.error ?? remove.error

  if (cart.lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="size-6" />}
        title="Your basket is empty"
        description="Nothing in here yet. Have a look at what is in the shop."
        actions={
          <Link
            to="/products"
            className="bg-brand-600 hover:bg-brand-700 inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white"
          >
            Browse the shop
          </Link>
        }
      />
    )
  }

  const unbuyable = cart.lines.filter((line) => !line.purchasable)

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="flex flex-col gap-4">
        {unbuyable.length > 0 ? (
          <p className="border-warn/30 bg-warn-soft text-warn flex items-start gap-2 rounded-lg border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {unbuyable.length === 1
                ? 'One item can no longer be bought. Remove it to carry on.'
                : `${unbuyable.length} items can no longer be bought. Remove them to carry on.`}
            </span>
          </p>
        ) : null}

        {failure ? (
          <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-4 py-3 text-sm">
            {messageOf(failure)}
          </p>
        ) : null}

        <ul className="border-line bg-surface rounded-card divide-line divide-y border">
          {cart.lines.map((line) => (
            <li key={line.variantId} className="flex items-start gap-4 p-4">
              <Link
                to={`/products/${line.handle}`}
                className="bg-sunken size-20 shrink-0 overflow-hidden rounded-lg"
              >
                {line.image ? (
                  <img src={line.image} alt="" className="size-full object-cover" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="text-brand-300 font-display flex size-full items-center justify-center text-2xl"
                  >
                    {line.productTitle.slice(0, 1)}
                  </span>
                )}
              </Link>

              <div className="min-w-0 flex-1">
                <Link
                  to={`/products/${line.handle}`}
                  className="text-ink hover:text-brand-700 font-medium"
                >
                  {line.productTitle}
                </Link>
                {line.variantTitle ? (
                  <p className="text-muted text-sm">{line.variantTitle}</p>
                ) : null}
                {line.problem ? (
                  <p className="text-bad mt-1 text-sm font-medium">{line.problem}</p>
                ) : null}

                <div className="mt-2 flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`One fewer ${line.productTitle}`}
                    disabled={isSaving || line.quantity <= 1}
                    onClick={() =>
                      setQuantity.mutate({ variantId: line.variantId, quantity: line.quantity - 1 })
                    }
                  >
                    <Minus className="size-3.5" />
                  </Button>
                  <span className="text-ink tabular w-8 text-center text-sm">{line.quantity}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`One more ${line.productTitle}`}
                    disabled={isSaving || !line.purchasable}
                    onClick={() =>
                      setQuantity.mutate({ variantId: line.variantId, quantity: line.quantity + 1 })
                    }
                  >
                    <Plus className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    className="ml-1"
                    aria-label={`Remove ${line.productTitle}`}
                    disabled={isSaving}
                    onClick={() => remove.mutate(line.variantId)}
                  >
                    <Trash2 className="text-bad size-3.5" />
                  </Button>
                </div>
              </div>

              <div className="w-24 shrink-0 text-right">
                <span className="text-ink tabular block font-medium">
                  {formatMoney(line.lineTotal)}
                </span>
                <span className="text-faint tabular block text-xs">
                  {formatMoney(line.unitPrice)} each
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <aside className="border-line bg-surface rounded-card sticky top-24 flex flex-col gap-4 border p-5">
        <h2 className="text-lg">Summary</h2>

        <div className="flex items-baseline justify-between">
          <span className="text-muted text-sm">
            {plural(cart.totals.itemCount, 'item')}
          </span>
          <span className="text-ink tabular font-medium">{formatMoney(cart.totals.subtotal)}</span>
        </div>

        {/* Neither can be known without an address, and a guess here that
            checkout then contradicts is worse than saying so. */}
        <p className="text-faint border-line border-t pt-3 text-xs">
          Delivery and tax are worked out at checkout, once you have given an
          address.
        </p>

        <Link
          to="/checkout"
          aria-disabled={!cart.purchasable}
          onClick={(event) => {
            if (!cart.purchasable) event.preventDefault()
          }}
          className={
            cart.purchasable
              ? 'bg-brand-600 hover:bg-brand-700 inline-flex h-12 w-full items-center justify-center rounded-lg text-base font-medium text-white transition-colors'
              : 'bg-brand-300 pointer-events-none inline-flex h-12 w-full items-center justify-center rounded-lg text-base font-medium text-white opacity-70'
          }
        >
          Go to checkout
        </Link>

        <Link to="/products" className="text-brand-600 text-center text-sm hover:underline">
          Keep shopping
        </Link>
      </aside>
    </div>
  )
}

function CartSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  )
}
