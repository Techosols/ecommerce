import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api'
import { useAuth } from '../useAuth'
import { useCancelMyOrder, useMyOrder } from '../hooks/account.hooks'
import { ReturnRequest } from '../components/ReturnRequest'
import { OrderView } from './OrderPage'

/**
 * One of the signed-in customer's orders.
 *
 * Fetched by id against their own session — the server matches on the owner, so
 * asking for somebody else's order id returns a 404 rather than a refusal that
 * would confirm it exists. The signed-in guard is `AccountLayout`'s.
 */
export function MyOrderPage() {
  const { id } = useParams()
  const { isSignedIn } = useAuth()
  const query = useMyOrder(id, isSignedIn)

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/account/orders"
        className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-3.5" /> Your orders
      </Link>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="mx-auto h-96 w-full max-w-2xl" />}
      >
        {query.data ? <WithActions order={query.data} /> : null}
      </QueryBoundary>
    </div>
  )
}

function WithActions({ order }) {
  const cancel = useCancelMyOrder()
  const { isSignedIn } = useAuth()
  const [confirming, setConfirming] = useState(false)

  // The server allows a customer to cancel only before anything has shipped.
  // Offering the button past that point would be a promise it will refuse.
  const cancellable = order.status === 'pending' || order.status === 'confirmed'

  return (
    <OrderView
      order={order}
      actions={
        <>
          {/* Returning is only possible once something has actually gone out,
              and the server decides when that is — this asks rather than
              inferring it from the status vocabulary. */}
          {!cancellable ? <ReturnRequest orderId={order.id} enabled={isSignedIn} /> : null}
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

            {confirming ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  isLoading={cancel.isPending}
                  onClick={() => cancel.mutate({ id: order.id })}
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
