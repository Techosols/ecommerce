import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Mail } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { idleFor } from '../components/failureLabels'
import { useCart, useRecoverCart } from '../hooks/checkout.hooks'
import type { CartDetail } from '../types/checkout.types'

/**
 * One basket, as the shopper would find it.
 *
 * Resolved through the same code the storefront uses, which is the point: a
 * line that has gone out of stock or been archived since shows here as
 * unbuyable, and that is very often the answer to why the basket was left.
 *
 * Nothing on this page changes the basket. Editing somebody's shopping behind
 * their back is not a thing a shop should be able to do, and the server
 * publishes no endpoint that would.
 */
export function CartDetailPage() {
  const { id } = useParams<{ id: string }>()
  const query = useCart(id)
  useDocumentTitle('Basket')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/checkout"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Baskets
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {query.data ? <CartView cart={query.data} /> : null}
      </QueryBoundary>
    </div>
  )
}

function CartView({ cart }: { cart: CartDetail }) {
  const { can } = useAuth()
  const { toast } = useToast()
  const recover = useRecoverCart()
  const [sentTo, setSentTo] = useState<string | null>(null)

  const canEmail = can('customers:write')
  const isGuest = cart.customer === null
  const unbuyable = cart.lines.filter((line) => !line.purchasable)

  function send() {
    recover.mutate(cart.id, {
      onSuccess: (result) => {
        if (result.sent) {
          setSentTo(result.to)
          toast({ tone: 'success', title: 'Recovery email queued', description: `To ${result.to}` })
        } else {
          // Not a failure: the shop asked a reasonable question and the answer
          // is that this person has opted out of being approached.
          toast({
            tone: 'info',
            title: 'Not sent',
            ...(result.reason ? { description: result.reason } : {}),
          })
        }
      },
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not send it', description: messageOf(error) }),
    })
  }

  return (
    <>
      <PageHeader
        title={cart.customer?.name ?? cart.customer?.email ?? 'A guest basket'}
        description={
          cart.customer ? (
            <Link to={`/customers/${cart.customer.id}`} className="text-brand-600 hover:underline">
              {cart.customer.email}
            </Link>
          ) : (
            'No account behind it, so there is no address to write to.'
          )
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                cart.status === 'converted'
                  ? 'positive'
                  : cart.status === 'active'
                    ? 'info'
                    : 'neutral'
              }
            >
              {cart.status === 'converted'
                ? 'Became an order'
                : cart.status === 'active'
                  ? 'Still open'
                  : 'Left behind'}
            </Badge>

            {canEmail && !isGuest && cart.status !== 'converted' && cart.lines.length > 0 ? (
              <Button
                variant="primary"
                leadingIcon={<Mail className="size-4" />}
                isLoading={recover.isPending}
                onClick={send}
              >
                {sentTo ? 'Send again' : 'Email them a link back'}
              </Button>
            ) : null}
          </div>
        }
      />

      {cart.convertedOrderId ? (
        <Alert tone="positive" title="This basket was bought">
          <Link to={`/orders/${cart.convertedOrderId}`} className="underline">
            Open the order it became
          </Link>
          .
        </Alert>
      ) : null}

      {unbuyable.length > 0 ? (
        <Alert tone="warning" title="Some of this can no longer be bought">
          {/* Very often the answer to why the basket was left: the shopper came
              back, found this, and gave up. */}
          {unbuyable.length === 1
            ? `${unbuyable[0]?.productTitle} is unavailable, so a shopper returning to this basket could not check out.`
            : `${unbuyable.length} of these lines are unavailable, so a shopper returning to this basket could not check out.`}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="What is in it"
            description="At today's prices — a basket stores what was chosen, never what it cost."
          />
          <CardBody>
            {cart.lines.length === 0 ? (
              <p className="text-muted text-sm">The basket is empty.</p>
            ) : (
              <ul className="divide-line divide-y">
                {cart.lines.map((line) => (
                  <li key={line.variantId} className="flex items-center gap-3 py-3">
                    {line.imageUrl ? (
                      <img
                        src={line.imageUrl}
                        alt=""
                        className="border-line size-10 shrink-0 rounded border object-cover"
                      />
                    ) : (
                      <span className="bg-surface-sunken size-10 shrink-0 rounded" />
                    )}

                    <span className="min-w-0 flex-1">
                      <Link
                        to={`/products/${line.productId}`}
                        className="text-ink hover:text-brand-600 block truncate text-sm font-medium"
                      >
                        {line.productTitle}
                      </Link>
                      <span className="text-faint block truncate text-xs">
                        {line.variantTitle ?? 'Default'}
                        {line.sku ? ` · ${line.sku}` : ''}
                      </span>
                      {!line.purchasable ? (
                        <span className="text-warning mt-0.5 flex items-center gap-1 text-xs">
                          <AlertTriangle className="size-3" />
                          {line.problem ?? 'No longer available'}
                        </span>
                      ) : null}
                    </span>

                    <span className="text-muted shrink-0 text-sm">
                      {formatNumber(line.quantity)} × {formatMoney(line.unitPrice)}
                    </span>
                    <span className="text-ink tabular w-20 shrink-0 text-right text-sm font-medium">
                      {formatMoney(line.lineTotal)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Worth now" />
            <CardBody className="flex flex-col gap-2">
              <p className="text-ink text-2xl font-semibold">
                {formatMoney(cart.totals.subtotal)}
              </p>
              <p className="text-muted text-sm">
                {formatNumber(cart.totals.itemCount)}{' '}
                {cart.totals.itemCount === 1 ? 'item' : 'items'}, before delivery and tax.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="History" />
            <CardBody className="flex flex-col gap-3 text-sm">
              <div>
                <p className="text-faint text-xs">Started</p>
                <p className="text-ink">{formatDateTime(cart.createdAt)}</p>
              </div>
              <div>
                <p className="text-faint text-xs">Last touched</p>
                <p className="text-ink">
                  {formatDateTime(cart.lastActivityAt)}
                  <span className="text-muted"> · {idleFor(cart.lastActivityAt)} ago</span>
                </p>
              </div>
              <div>
                <p className="text-faint text-xs">Expires</p>
                <p className="text-ink">{formatDateTime(cart.expiresAt)}</p>
              </div>
            </CardBody>
          </Card>

          {isGuest ? (
            <Alert tone="info">
              A guest basket carries no address, so there is nobody to email. It is here because it
              still says what people are putting down and leaving.
            </Alert>
          ) : null}
        </div>
      </div>
    </>
  )
}
