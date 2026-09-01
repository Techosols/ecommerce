import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, PackageOpen } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useOrder } from '@/features/orders/hooks/orders.hooks'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney } from '@/lib/format'
import {
  useMoveReturn,
  useReceiveReturn,
  useRefundReturn,
  useReturn,
} from '../hooks/returns.hooks'
import { conditionLabels, reasonLabels, statusTones } from '../components/returnLabels'
import { RefundDialog } from '../components/RefundDialog'
import type { ReturnAction, ReturnCondition, ReturnDetail } from '../types/returns.types'

const conditions: ReturnCondition[] = ['resellable', 'damaged', 'opened', 'missing_parts']

/** What the operator is filling in while the parcel is open on the bench. */
interface Receipt {
  receivedQuantity: number
  condition: ReturnCondition
}

/**
 * One return, from request to closed.
 *
 * The buttons on offer are the moves the server will actually accept from the
 * current state — a `closed` return shows none, because the lifecycle has no
 * exit from it and offering one would be a promise the server breaks.
 *
 * The receiving form is the heart of the page. It asks for a quantity **and a
 * condition** per line, and says beside each condition what it does to stock,
 * because that is the decision being made: only resellable units go back on
 * sale, and the operator choosing "damaged" is writing goods off.
 */
export function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const { can } = useAuth()

  const query = useReturn(id)
  const request = query.data
  const order = useOrder(request?.order.id)

  const move = useMoveReturn(id ?? '')
  const receive = useReceiveReturn(id ?? '')
  const refund = useRefundReturn(id ?? '')

  const [receipts, setReceipts] = useState<Record<string, Receipt>>({})
  const [staffNote, setStaffNote] = useState('')
  const [confirming, setConfirming] = useState<ReturnAction | null>(null)
  const [refunding, setRefunding] = useState(false)

  useDocumentTitle(request ? `Return ${request.returnNumber}` : 'Return')

  const canWrite = can('returns:write')
  const canRefund = can('payments:refund') && canWrite

  const status = request?.status
  const canReceive = status === 'approved' || status === 'in_transit'
  const canRefundNow = status === 'received' && request?.refundId === null

  function run(label: string, promise: Promise<unknown>) {
    promise
      .then(() => toast({ tone: 'success', title: label }))
      .catch((error: unknown) =>
        toast({ tone: 'error', title: 'That did not work', description: messageOf(error) }),
      )
      .finally(() => setConfirming(null))
  }

  function submitReceipt(detail: ReturnDetail) {
    receive.mutate(
      {
        lines: detail.lines.map((line) => ({
          orderItemId: line.orderItemId,
          receivedQuantity: receipts[line.orderItemId]?.receivedQuantity ?? 0,
          condition: receipts[line.orderItemId]?.condition ?? 'missing_parts',
        })),
        ...(staffNote.trim() ? { staffNote: staffNote.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Recorded what arrived' })
          setStaffNote('')
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not record it', description: messageOf(error) }),
      },
    )
  }

  return (
    <QueryBoundary
      isLoading={query.isPending}
      error={query.error}
      variant="page"
      onRetry={() => void query.refetch()}
    >
      {request ? (
        <div className="flex flex-col gap-6">
          <PageHeader
            title={request.returnNumber}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTones[request.status].tone}>
                  {statusTones[request.status].label}
                </Badge>
                <span className="text-muted text-sm">{reasonLabels[request.reason]}</span>
                <Link
                  to={`/orders/${request.order.id}`}
                  className="text-brand-600 text-sm hover:underline"
                >
                  {request.order.orderNumber}
                </Link>
              </span>
            }
            actions={
              <Button
                variant="ghost"
                leadingIcon={<ArrowLeft className="size-4" />}
                onClick={() => void navigate('/returns')}
              >
                All returns
              </Button>
            }
          />

          {request.status === 'declined' ? (
            <Alert tone="warning" title="This return was declined">
              {request.staffNote ?? 'No reason was recorded.'} The units went back to being
              returnable, so the customer can open a fresh request.
            </Alert>
          ) : null}

          <div className="grid items-start gap-4 xl:grid-cols-3">
            <div className="flex flex-col gap-4 xl:col-span-2">
              <Card>
                <CardHeader
                  title="Items"
                  description={
                    canReceive
                      ? 'Record what actually arrived, and what state it is in.'
                      : 'What was sent back.'
                  }
                />
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-line bg-surface-sunken border-b">
                        <th className="text-muted px-4 py-2.5 text-left text-xs font-semibold">
                          Item
                        </th>
                        <th className="text-muted px-4 py-2.5 text-right text-xs font-semibold">
                          Expected
                        </th>
                        <th className="text-muted px-4 py-2.5 text-left text-xs font-semibold">
                          {canReceive ? 'Arrived' : 'Received'}
                        </th>
                        <th className="text-muted px-4 py-2.5 text-left text-xs font-semibold">
                          Condition
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {request.lines.map((line) => {
                        const item = order.data?.items.find(
                          (candidate) => candidate.id === line.orderItemId,
                        )
                        const receipt = receipts[line.orderItemId]
                        return (
                          <tr key={line.id} className="border-line border-b last:border-0">
                            <td className="px-4 py-3">
                              <span className="text-ink block font-medium">
                                {item?.productTitle ?? 'Item'}
                              </span>
                              {item?.sku ? (
                                <span className="text-faint block font-mono text-xs">
                                  {item.sku}
                                </span>
                              ) : null}
                            </td>
                            <td className="text-ink tabular px-4 py-3 text-right">
                              {line.quantity}
                            </td>
                            <td className="px-4 py-3">
                              {canReceive && canWrite ? (
                                <Input
                                  type="number"
                                  size="sm"
                                  min={0}
                                  max={line.quantity}
                                  className="w-20"
                                  aria-label={`Quantity received for ${item?.productTitle ?? 'this line'}`}
                                  value={String(receipt?.receivedQuantity ?? '')}
                                  onChange={(event) => {
                                    const raw = Number(event.target.value)
                                    const next = Number.isFinite(raw)
                                      ? Math.max(0, Math.min(line.quantity, Math.floor(raw)))
                                      : 0
                                    setReceipts((current) => ({
                                      ...current,
                                      [line.orderItemId]: {
                                        receivedQuantity: next,
                                        condition: current[line.orderItemId]?.condition ?? 'resellable',
                                      },
                                    }))
                                  }}
                                />
                              ) : (
                                <span className="text-ink tabular">{line.receivedQuantity}</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {canReceive && canWrite ? (
                                <Select
                                  size="sm"
                                  className="w-44"
                                  aria-label={`Condition for ${item?.productTitle ?? 'this line'}`}
                                  value={receipt?.condition ?? 'resellable'}
                                  onChange={(event) =>
                                    setReceipts((current) => ({
                                      ...current,
                                      [line.orderItemId]: {
                                        receivedQuantity:
                                          current[line.orderItemId]?.receivedQuantity ?? 0,
                                        condition: event.target.value as ReturnCondition,
                                      },
                                    }))
                                  }
                                  options={conditions.map((value) => ({
                                    value,
                                    label: `${conditionLabels[value].label} — ${conditionLabels[value].effect.toLowerCase()}`,
                                  }))}
                                />
                              ) : line.condition ? (
                                <span>
                                  <Badge
                                    tone={line.condition === 'resellable' ? 'positive' : 'neutral'}
                                    size="sm"
                                  >
                                    {conditionLabels[line.condition].label}
                                  </Badge>
                                  {line.restockedQuantity > 0 ? (
                                    <span className="text-muted mt-0.5 block text-xs">
                                      {line.restockedQuantity} back on the shelf
                                    </span>
                                  ) : line.receivedQuantity > 0 ? (
                                    <span className="text-muted mt-0.5 block text-xs">
                                      Written off
                                    </span>
                                  ) : null}
                                </span>
                              ) : (
                                <span className="text-faint text-xs">Not yet arrived</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {canReceive && canWrite ? (
                  <CardBody className="border-line flex flex-col gap-3 border-t">
                    <Field label="Note" hint="Optional. Recorded against the return.">
                      <Textarea
                        rows={2}
                        value={staffNote}
                        maxLength={1000}
                        placeholder="Box was open when it arrived."
                        onChange={(event) => setStaffNote(event.target.value)}
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button
                        variant="primary"
                        isLoading={receive.isPending}
                        onClick={() => submitReceipt(request)}
                      >
                        Record what arrived
                      </Button>
                    </div>
                  </CardBody>
                ) : null}
              </Card>

              {canRefundNow && canRefund ? (
                <Card>
                  <CardHeader
                    title="Refund"
                    description="The goods are back. What comes off the bill is a separate decision."
                    actions={
                      <Button variant="primary" size="sm" onClick={() => setRefunding(true)}>
                        Refund and close
                      </Button>
                    }
                  />
                  <CardBody>
                    <p className="text-muted text-sm">
                      Only the units recorded as arrived are refunded, and they are not restocked
                      again — that happened when they were received.
                    </p>
                  </CardBody>
                </Card>
              ) : null}

              {request.refundId ? (
                <Alert tone="info" title="Refunded">
                  This return was refunded and closed
                  {request.closedAt ? ` on ${formatDateTime(request.closedAt)}` : ''}.
                </Alert>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader title="Progress" />
                <CardBody className="flex flex-col gap-3">
                  <dl className="flex flex-col gap-2 text-sm">
                    <Row label="Requested" value={formatDateTime(request.requestedAt)} />
                    {request.approvedAt ? (
                      <Row label="Approved" value={formatDateTime(request.approvedAt)} />
                    ) : null}
                    {request.receivedAt ? (
                      <Row label="Received" value={formatDateTime(request.receivedAt)} />
                    ) : null}
                    {request.closedAt ? (
                      <Row label="Closed" value={formatDateTime(request.closedAt)} />
                    ) : null}
                    {order.data ? (
                      <Row label="Order total" value={formatMoney(order.data.totals.total)} />
                    ) : null}
                  </dl>

                  {canWrite ? (
                    <div className="border-line flex flex-col gap-2 border-t pt-3">
                      {status === 'requested' ? (
                        <>
                          <Button
                            variant="primary"
                            fullWidth
                            isLoading={move.isPending}
                            onClick={() =>
                              run('Return approved', move.mutateAsync({ action: 'approve' }))
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            variant="secondary"
                            fullWidth
                            onClick={() => setConfirming('decline')}
                          >
                            Decline
                          </Button>
                        </>
                      ) : null}

                      {status === 'approved' ? (
                        <Button
                          variant="secondary"
                          fullWidth
                          isLoading={move.isPending}
                          onClick={() =>
                            run('Marked on its way', move.mutateAsync({ action: 'in-transit' }))
                          }
                        >
                          Mark on its way
                        </Button>
                      ) : null}

                      {status === 'received' ? (
                        <Button
                          variant="secondary"
                          fullWidth
                          onClick={() => setConfirming('close')}
                        >
                          Close without refunding
                        </Button>
                      ) : null}

                      {status === 'requested' ||
                      status === 'approved' ||
                      status === 'in_transit' ? (
                        <Button
                          variant="ghost"
                          fullWidth
                          className="text-danger hover:bg-danger-soft"
                          onClick={() => setConfirming('cancel')}
                        >
                          Cancel return
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Customer" />
                <CardBody className="flex flex-col gap-3 text-sm">
                  <p className="text-ink">{request.order.email}</p>
                  {request.customerNote ? (
                    <div>
                      <p className="text-muted mb-1 text-xs font-semibold tracking-wide uppercase">
                        What they said
                      </p>
                      <p className="text-ink-soft whitespace-pre-wrap">{request.customerNote}</p>
                    </div>
                  ) : null}
                  {request.staffNote ? (
                    <div>
                      <p className="text-muted mb-1 text-xs font-semibold tracking-wide uppercase">
                        Staff note
                      </p>
                      <p className="text-ink-soft whitespace-pre-wrap">{request.staffNote}</p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </div>
          </div>

          <ConfirmDialog
            isOpen={confirming !== null}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              if (!confirming) return
              run(
                confirming === 'decline'
                  ? 'Return declined'
                  : confirming === 'cancel'
                    ? 'Return cancelled'
                    : 'Return closed',
                move.mutateAsync({ action: confirming }),
              )
            }}
            title={
              confirming === 'decline'
                ? 'Decline this return?'
                : confirming === 'cancel'
                  ? 'Cancel this return?'
                  : 'Close without refunding?'
            }
            confirmLabel={
              confirming === 'decline'
                ? 'Decline'
                : confirming === 'cancel'
                  ? 'Cancel return'
                  : 'Close'
            }
            tone={confirming === 'close' ? 'primary' : 'danger'}
            isLoading={move.isPending}
          >
            {confirming === 'close'
              ? 'The return is finished with no money going back — an exchange, or a replacement already sent.'
              : 'The units go back to being returnable, so the customer can open a fresh request. Nothing is deleted.'}
          </ConfirmDialog>

          <RefundDialog
            orderId={request.order.id}
            isOpen={refunding}
            onClose={() => setRefunding(false)}
            isSubmitting={refund.isPending}
            onSubmit={(input) =>
              refund.mutateAsync({
                paymentId: input.paymentId,
                amountCents: input.amountCents,
                reason: input.reason,
              })
            }
          />
        </div>
      ) : (
        <Card>
          <CardBody>
            <p className="text-muted text-sm">
              <PackageOpen className="mr-2 inline size-4" />
              That return could not be found.{' '}
              <Link to="/returns" className="text-brand-600">
                Back to returns
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
