import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Banknote,
  ImageOff,
  RotateCcw,
  ShoppingCart,
  Truck,
  XCircle,
} from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import {
  useCreateShipment,
  useOrder,
  useOrderAction,
  useOrderPayments,
  useOrderShipments,
  useRecordPayment,
  useRefundOrder,
} from '../hooks/orders.hooks'
import { RefundDialog } from '@/features/returns/components/RefundDialog'
import { useOrderReturns } from '@/features/returns/hooks/returns.hooks'
import { TrackingTimeline } from '@/features/shipping/components/TrackingTimeline'
import { useCarrierCapabilities } from '@/features/shipping/hooks/carrier.hooks'
import { statusTones as returnTones } from '@/features/returns/components/returnLabels'
import { OrderAnnotationsCard } from '../components/OrderAnnotationsCard'
import { OrderStatusTriple } from '../components/OrderStatusBadges'
import { OrderTimeline } from '../components/OrderTimeline'
import { OrderTotalsCard } from '../components/OrderTotalsCard'
import { OrderProofsCard } from '@/features/payments/components/OrderProofsCard'
import type { OrderAddress, OrderDetail, OrderItem } from '../types/orders.types'

/** What is left to ship on a line, once shipped and refunded units are taken off. */
function outstandingOf(item: OrderItem): number {
  return Math.max(0, item.quantity - item.fulfilledQuantity - item.refundedQuantity)
}

function AddressBlock({ address }: { address: OrderAddress }) {
  return (
    <address className="text-ink-soft text-sm not-italic">
      <span className="text-ink block font-medium">
        {address.firstName} {address.lastName}
      </span>
      {address.company ? <span className="block">{address.company}</span> : null}
      <span className="block">{address.line1}</span>
      {address.line2 ? <span className="block">{address.line2}</span> : null}
      <span className="block">
        {address.city}
        {address.region ? `, ${address.region}` : ''} {address.postalCode ?? ''}
      </span>
      <span className="block">{address.countryCode}</span>
      {address.phone ? <span className="text-muted mt-1 block text-xs">{address.phone}</span> : null}
    </address>
  )
}

/**
 * One order, and everything a shop does with it.
 *
 * Read down the middle: what was bought, what it came to, what money has moved,
 * what has gone out, and then the running record of all of it. The sidebar
 * holds what the operator acts on — the three statuses and their moves, who the
 * customer is, and the staff annotation.
 *
 * Nothing here computes money. Totals, outstanding balance and refunded amounts
 * all come from the server, which enforces the arithmetic in a database
 * constraint; a second calculation in the browser could only agree or be wrong.
 *
 * Every action is a named server operation rather than a field edit. There is
 * no `PATCH /orders/:id` to reach for, because an order's money is fixed at
 * checkout and its statuses move through transitions that record who moved
 * them and why.
 */
export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { can } = useAuth()

  const query = useOrder(id)
  const order = query.data
  const payments = useOrderPayments(id)
  const shipments = useOrderShipments(id)
  const returns = useOrderReturns(id)
  // Whether a courier reports scans at all. Cached for the session, so this is
  // one request for the whole admin rather than one per order opened.
  const carrier = useCarrierCapabilities()
  const action = useOrderAction(id ?? '')
  const recordPayment = useRecordPayment(id ?? '')
  const createShipment = useCreateShipment(id ?? '')
  const refundOrder = useRefundOrder(id ?? '')

  const [confirming, setConfirming] = useState<'cancel' | 'fulfil' | 'payment' | null>(null)
  const [refunding, setRefunding] = useState(false)

  const canWrite = can('orders:write')
  const canCancel = can('orders:cancel')
  const canCapture = can('payments:capture')
  const canRefund = can('payments:refund')
  const canShip = can('shipping:write')

  useDocumentTitle(order ? `Order ${order.orderNumber}` : 'Order')

  const isCancelled = order?.status === 'cancelled'
  const outstandingItems = (order?.items ?? [])
    .filter((item) => item.requiresShipping && outstandingOf(item) > 0)
    .map((item) => ({ orderItemId: item.id, quantity: outstandingOf(item) }))

  function run(label: string, promise: Promise<unknown>) {
    promise
      .then(() => toast({ tone: 'success', title: label }))
      .catch((error: unknown) =>
        toast({ tone: 'error', title: 'That did not work', description: messageOf(error) }),
      )
      .finally(() => setConfirming(null))
  }

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      variant="page"
      onRetry={() => void query.refetch()}
    >
      {order ? (
        <div className="flex flex-col gap-6">
          <PageHeader
            title={order.orderNumber}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <OrderStatusTriple
                  status={order.status}
                  paymentStatus={order.paymentStatus}
                  fulfillmentStatus={order.fulfillmentStatus}
                />
                <span className="text-faint text-xs">{formatDateTime(order.placedAt)}</span>
              </span>
            }
            actions={
              <Button
                variant="ghost"
                leadingIcon={<ArrowLeft className="size-4" />}
                onClick={() => void navigate('/orders')}
              >
                All orders
              </Button>
            }
          />

          {isCancelled ? (
            <Alert tone="warning" title="This order was cancelled">
              {order.cancelReason ?? 'No reason was recorded.'} Stock was returned to the shelf
              unless staff chose otherwise. Nothing is deleted — the order stays as a record of what
              happened.
            </Alert>
          ) : null}

          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="flex flex-col gap-4 xl:col-span-2">
              <ItemsCard order={order} />

              <OrderTotalsCard order={order} />

              {/* Renders itself away unless this order was to be paid by bank
                  transfer, so it never appears as a blank card on a COD order. */}
              <OrderProofsCard orderId={order.id} paymentMethod={order.paymentMethod} />

              {can('payments:read') ? (
                <Card>
                  <CardHeader
                    title="Payments"
                    description="Money received and money sent back."
                    actions={
                      <>
                        {canCapture && !isCancelled && (payments.data?.outstanding?.amount ?? 0) > 0 ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            leadingIcon={<Banknote className="size-4" />}
                            isLoading={recordPayment.isPending}
                            onClick={() => setConfirming('payment')}
                          >
                            Record payment
                          </Button>
                        ) : null}
                        {canRefund && (payments.data?.payments?.length ?? 0) > 0 ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            leadingIcon={<RotateCcw className="size-4" />}
                            onClick={() => setRefunding(true)}
                          >
                            Refund
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                  <CardBody className="flex flex-col gap-3">
                    <QueryBoundary
                      isLoading={payments.isPending}
                      error={payments.error}
                      onRetry={() => void payments.refetch()}
                    >
                      {payments.data ? (
                        <>
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="text-muted text-sm">Outstanding</span>
                            <span
                              className={
                                payments.data.outstanding.amount > 0
                                  ? 'text-warning tabular text-sm font-semibold'
                                  : 'text-positive tabular text-sm font-semibold'
                              }
                            >
                              {formatMoney(payments.data.outstanding)}
                            </span>
                          </div>

                          {payments.data.payments.length === 0 ? (
                            <p className="text-muted text-sm">No money has been received yet.</p>
                          ) : (
                            <ul className="divide-line border-line divide-y rounded-lg border">
                              {payments.data.payments.map((payment) => (
                                <li
                                  key={payment.id}
                                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                                >
                                  <span className="min-w-0">
                                    <span className="text-ink block font-medium">
                                      {formatMoney(payment.amount)}
                                    </span>
                                    <span className="text-faint block text-xs">
                                      {payment.method} · {payment.status} ·{' '}
                                      {formatDateTime(payment.capturedAt ?? payment.createdAt)}
                                    </span>
                                  </span>
                                  {payment.refunded.amount > 0 ? (
                                    <Badge tone="warning" size="sm">
                                      {formatMoney(payment.refunded)} refunded
                                    </Badge>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}

                          {payments.data.refunds.length > 0 ? (
                            <div>
                              <p className="text-muted mb-1.5 text-xs font-semibold tracking-wide uppercase">
                                Refunds
                              </p>
                              <ul className="divide-line border-line divide-y rounded-lg border">
                                {payments.data.refunds.map((refund) => (
                                  <li
                                    key={refund.id}
                                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                                  >
                                    <span className="min-w-0">
                                      <span className="text-ink block font-medium">
                                        {formatMoney(refund.amount)}
                                      </span>
                                      <span className="text-faint block text-xs">
                                        {refund.reason ?? 'No reason recorded'} ·{' '}
                                        {formatDateTime(refund.createdAt)}
                                      </span>
                                    </span>
                                    <Badge tone={refund.restock ? 'info' : 'neutral'} size="sm">
                                      {refund.restock ? 'Restocked' : 'Not restocked'}
                                    </Badge>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </QueryBoundary>
                  </CardBody>
                </Card>
              ) : null}

              {can('shipping:read') ? (
                <Card>
                  <CardHeader
                    title="Shipments"
                    description="What has physically left, and where it is."
                    actions={
                      canShip && !isCancelled && outstandingItems.length > 0 ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Truck className="size-4" />}
                          isLoading={createShipment.isPending}
                          onClick={() => setConfirming('fulfil')}
                        >
                          Fulfil everything left
                        </Button>
                      ) : undefined
                    }
                  />
                  <CardBody>
                    <QueryBoundary
                      isLoading={shipments.isPending}
                      error={shipments.error}
                      onRetry={() => void shipments.refetch()}
                    >
                      {shipments.data && shipments.data.length > 0 ? (
                        <ul className="divide-line border-line divide-y rounded-lg border">
                          {shipments.data.map((shipment) => (
                            <li key={shipment.id} className="px-3 py-2.5 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-ink font-medium">
                                  {shipment.items.reduce((sum, item) => sum + item.quantity, 0)}{' '}
                                  items
                                </span>
                                <Badge size="sm" tone="info">
                                  {shipment.status}
                                </Badge>
                              </div>
                              <span className="text-faint block text-xs">
                                {shipment.carrier ?? 'No carrier'}
                                {shipment.trackingNumber ? ` · ${shipment.trackingNumber}` : ''} ·{' '}
                                {formatDateTime(shipment.shippedAt ?? shipment.createdAt)}
                              </span>
                              {/* Only where a courier reports scans: with none
                                  connected the trail is always empty, and an
                                  expander that opens onto nothing is worse than
                                  no expander. */}
                              <TrackingTimeline
                                shipmentId={shipment.id}
                                enabled={Boolean(carrier.data?.tracking)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted text-sm">
                          {outstandingItems.length === 0
                            ? 'Nothing on this order needs shipping.'
                            : 'Nothing has been shipped yet.'}
                        </p>
                      )}
                    </QueryBoundary>
                  </CardBody>
                </Card>
              ) : null}

              {can('returns:read') && (returns.data?.length ?? 0) > 0 ? (
                <Card>
                  <CardHeader
                    title="Returns"
                    description="Goods coming back from this order."
                  />
                  <CardBody>
                    <ul className="divide-line border-line divide-y rounded-lg border">
                      {returns.data?.map((entry) => (
                        <li key={entry.id}>
                          <Link
                            to={`/returns/${entry.id}`}
                            className="hover:bg-surface-hover flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
                          >
                            <span className="min-w-0">
                              <span className="text-ink block font-medium">
                                {entry.returnNumber}
                              </span>
                              <span className="text-faint block text-xs">
                                {formatDateTime(entry.requestedAt)}
                              </span>
                            </span>
                            <span className="flex items-center gap-2">
                              {entry.refunded ? (
                                <Badge tone="positive" size="sm">
                                  Refunded
                                </Badge>
                              ) : null}
                              <Badge tone={returnTones[entry.status].tone} size="sm">
                                {returnTones[entry.status].label}
                              </Badge>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ) : null}

              <OrderTimeline orderId={order.id} canWrite={canWrite} />
            </div>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader title="Status" description="Three machines, moved separately." />
                <CardBody className="flex flex-col gap-3">
                  <dl className="flex flex-col gap-2 text-sm">
                    <Row label="Placed" value={formatDateTime(order.placedAt)} />
                    {order.confirmedAt ? (
                      <Row label="Confirmed" value={formatDateTime(order.confirmedAt)} />
                    ) : null}
                    {order.completedAt ? (
                      <Row label="Completed" value={formatDateTime(order.completedAt)} />
                    ) : null}
                    <Row label="Placed via" value={order.source === 'admin' ? 'Admin' : 'Storefront'} />
                    <Row label="Payment method" value={order.paymentMethod} />
                  </dl>

                  {canWrite && !isCancelled ? (
                    <div className="border-line flex flex-col gap-2 border-t pt-3">
                      {order.status === 'pending' ? (
                        <Button
                          variant="primary"
                          fullWidth
                          isLoading={action.isPending}
                          onClick={() =>
                            run('Order confirmed', action.mutateAsync({ kind: 'confirm' }))
                          }
                        >
                          Confirm order
                        </Button>
                      ) : null}

                      {order.status === 'confirmed' ? (
                        <Button
                          variant="secondary"
                          fullWidth
                          isLoading={action.isPending}
                          onClick={() =>
                            run(
                              'Order is being processed',
                              action.mutateAsync({
                                kind: 'transition',
                                field: 'status',
                                to: 'processing',
                              }),
                            )
                          }
                        >
                          Start processing
                        </Button>
                      ) : null}

                      {order.status === 'processing' ? (
                        <Button
                          variant="secondary"
                          fullWidth
                          isLoading={action.isPending}
                          onClick={() =>
                            run(
                              'Order completed',
                              action.mutateAsync({
                                kind: 'transition',
                                field: 'status',
                                to: 'completed',
                              }),
                            )
                          }
                        >
                          Mark completed
                        </Button>
                      ) : null}

                      {canCancel && order.status !== 'completed' ? (
                        <Button
                          variant="ghost"
                          fullWidth
                          leadingIcon={<XCircle className="size-4" />}
                          className="text-danger hover:bg-danger-soft"
                          onClick={() => setConfirming('cancel')}
                        >
                          Cancel order
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Customer" />
                <CardBody className="flex flex-col gap-4">
                  <div>
                    <p className="text-ink text-sm font-medium">{order.email}</p>
                    {order.phone ? <p className="text-muted text-sm">{order.phone}</p> : null}
                    <p className="text-faint mt-0.5 text-xs">
                      {order.customerId ? 'Registered account' : 'Guest checkout'}
                    </p>
                  </div>

                  {order.addresses.map((address) => (
                    <div key={address.type}>
                      <p className="text-muted mb-1 text-xs font-semibold tracking-wide uppercase">
                        {address.type === 'shipping' ? 'Ship to' : 'Bill to'}
                      </p>
                      <AddressBlock address={address} />
                    </div>
                  ))}

                  {order.customerNote ? (
                    <div>
                      <p className="text-muted mb-1 text-xs font-semibold tracking-wide uppercase">
                        Their note
                      </p>
                      <p className="text-ink-soft text-sm whitespace-pre-wrap">
                        {order.customerNote}
                      </p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              <OrderAnnotationsCard order={order} canWrite={canWrite} />
            </div>
          </div>

          <RefundDialog
            orderId={order.id}
            isOpen={refunding}
            onClose={() => setRefunding(false)}
            isSubmitting={refundOrder.isPending}
            onSubmit={(input) => refundOrder.mutateAsync(input)}
          />

          <ConfirmDialog
            isOpen={confirming === 'cancel'}
            onCancel={() => setConfirming(null)}
            onConfirm={() => run('Order cancelled', action.mutateAsync({ kind: 'cancel' }))}
            title={`Cancel ${order.orderNumber}?`}
            confirmLabel="Cancel order"
            tone="danger"
            isLoading={action.isPending}
          >
            Reserved stock goes back on the shelf and the customer is told. Nothing is deleted — the
            order stays as a record, and it cannot be un-cancelled.
          </ConfirmDialog>

          <ConfirmDialog
            isOpen={confirming === 'fulfil'}
            onCancel={() => setConfirming(null)}
            onConfirm={() =>
              run(
                'Shipment created',
                createShipment.mutateAsync({ items: outstandingItems }),
              )
            }
            title="Ship everything outstanding?"
            confirmLabel="Create shipment"
            isLoading={createShipment.isPending}
          >
            One shipment covering{' '}
            {formatNumber(outstandingItems.reduce((sum, item) => sum + item.quantity, 0))} items.
            Tracking can be added afterwards.
          </ConfirmDialog>

          <ConfirmDialog
            isOpen={confirming === 'payment'}
            onCancel={() => setConfirming(null)}
            onConfirm={() =>
              run(
                'Payment recorded',
                recordPayment.mutateAsync({ key: crypto.randomUUID() }),
              )
            }
            title="Record the outstanding balance as received?"
            confirmLabel="Record payment"
            isLoading={recordPayment.isPending}
          >
            The server takes the amount from the order rather than from this screen, so this records
            exactly what is outstanding —{' '}
            {payments.data ? formatMoney(payments.data.outstanding) : 'the remaining balance'}.
          </ConfirmDialog>
        </div>
      ) : (
        <Card>
          <CardBody>
            <p className="text-muted text-sm">
              <ShoppingCart className="mr-2 inline size-4" />
              That order could not be found.{' '}
              <Link to="/orders" className="text-brand-600">
                Back to orders
              </Link>
            </p>
          </CardBody>
        </Card>
      )}
    </QueryBoundary>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-soft text-xs">{value}</dd>
    </div>
  )
}

function ItemsCard({ order }: { order: OrderDetail }) {
  return (
    <Card>
      <CardHeader
        title={`${order.items.length} ${order.items.length === 1 ? 'item' : 'items'}`}
        description="What was bought, at the title and price it had then."
      />
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-line bg-surface-sunken border-b">
              <th className="text-muted px-4 py-2.5 text-left text-xs font-semibold">Item</th>
              <th className="text-muted px-4 py-2.5 text-right text-xs font-semibold">Price</th>
              <th className="text-muted px-4 py-2.5 text-right text-xs font-semibold">Qty</th>
              <th className="text-muted px-4 py-2.5 text-right text-xs font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => {
              const outstanding = outstandingOf(item)
              return (
                <tr key={item.id} className="border-line border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <span className="bg-surface-sunken border-line size-10 shrink-0 overflow-hidden rounded border">
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover"
                          />
                        ) : (
                          <span className="text-faint flex size-full items-center justify-center">
                            <ImageOff className="size-4" />
                          </span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="text-ink block font-medium">{item.productTitle}</span>
                        {item.options.length > 0 ? (
                          <span className="text-faint block text-xs">
                            {item.options.map((option) => option.value).join(' / ')}
                          </span>
                        ) : null}
                        {item.sku ? (
                          <span className="text-faint block font-mono text-xs">{item.sku}</span>
                        ) : null}
                        <span className="mt-1 flex flex-wrap gap-1">
                          {item.refundedQuantity > 0 ? (
                            <Badge tone="warning" size="sm">
                              {item.refundedQuantity} refunded
                            </Badge>
                          ) : null}
                          {item.requiresShipping && outstanding > 0 && item.fulfilledQuantity > 0 ? (
                            <Badge tone="info" size="sm">
                              {item.fulfilledQuantity} of {item.quantity} shipped
                            </Badge>
                          ) : null}
                          {!item.requiresShipping ? (
                            <Badge tone="neutral" size="sm">
                              No shipping
                            </Badge>
                          ) : null}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="text-muted tabular px-4 py-3 text-right">
                    {formatMoney(item.unitPrice)}
                  </td>
                  <td className="text-ink tabular px-4 py-3 text-right">{item.quantity}</td>
                  <td className="text-ink tabular px-4 py-3 text-right font-medium">
                    {formatMoney(item.total)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
