import { useMemo, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import { formatMoney } from '@/lib/format'
import { useRefundable } from '../hooks/returns.hooks'
import type { Refundable } from '../types/returns.types'

const reasons = [
  { value: 'customer_changed_mind', label: 'Customer changed their mind' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'goodwill', label: 'Goodwill' },
  { value: 'other', label: 'Other' },
]

export interface RefundDialogProps {
  orderId: string
  isOpen: boolean
  onClose: () => void
  onSubmit: (input: {
    paymentId: string
    amountCents: number
    reason: string
    restock: boolean
    items: { orderItemId: string; quantity: number }[]
  }) => Promise<unknown>
  isSubmitting: boolean
}

/**
 * Sending money back.
 *
 * Every maximum on this screen comes from `GET /orders/:id/refundable` — the
 * per-line quantities, the per-payment remainder and the order-level cap. The
 * browser computes one thing only: the running total of what the operator has
 * asked for, shown so they can see it before they commit. If that disagrees
 * with the server, the server wins and says so.
 *
 * **Restock is a separate decision and defaults to off.** A refund is money;
 * putting goods back on the shelf is stock. They coincide often enough that
 * tying them together looks like a convenience, and then a shop refunds a
 * damaged item and sells it again the same afternoon. The operator says.
 */
export function RefundDialog({
  orderId,
  isOpen,
  onClose,
  onSubmit,
  isSubmitting,
}: RefundDialogProps) {
  const { toast } = useToast()
  const query = useRefundable(orderId, isOpen)

  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [refundShipping, setRefundShipping] = useState(false)
  const [override, setOverride] = useState<number | null>(null)
  const [reason, setReason] = useState('customer_changed_mind')
  const [paymentId, setPaymentId] = useState('')
  const [restock, setRestock] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const data = query.data
  const chosenPayment = data?.payments.find((payment) => payment.id === paymentId) ?? data?.payments[0]

  /** What the lines and the shipping box add up to, before any override. */
  const suggested = useMemo(() => {
    if (!data) return 0
    const lines = data.lines.reduce(
      (sum, line) => sum + (quantities[line.orderItemId] ?? 0) * line.perUnit.amount,
      0,
    )
    return lines + (refundShipping ? data.shippingTotal.amount : 0)
  }, [data, quantities, refundShipping])

  const amount = override ?? suggested
  const items = (data?.lines ?? [])
    .filter((line) => (quantities[line.orderItemId] ?? 0) > 0)
    .map((line) => ({ orderItemId: line.orderItemId, quantity: quantities[line.orderItemId]! }))

  const max = chosenPayment
    ? Math.min(chosenPayment.refundable.amount, data?.maxRefundable.amount ?? 0)
    : (data?.maxRefundable.amount ?? 0)
  const overMax = amount > max

  function close() {
    setQuantities({})
    setRefundShipping(false)
    setOverride(null)
    setRestock(false)
    setError(null)
    onClose()
  }

  async function submit() {
    if (isSubmitting) return
    if (!chosenPayment) {
      setError('There is no captured payment on this order to refund.')
      return
    }
    if (amount <= 0) {
      setError('Choose the units coming back, or type an amount.')
      return
    }
    if (overMax) {
      setError(`That is more than the ${formatMoney({ amount: max, currency: data!.currency })} still refundable.`)
      return
    }
    if (restock && items.length === 0) {
      setError('Restocking needs the units coming back, so choose quantities first.')
      return
    }

    try {
      await onSubmit({
        paymentId: chosenPayment.id,
        amountCents: amount,
        reason,
        restock,
        items,
      })
      toast({ tone: 'success', title: 'Refund issued' })
      close()
    } catch (caught) {
      setError(messageOf(caught, 'The refund could not be issued.'))
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={isSubmitting ? () => undefined : close}
      dismissible={!isSubmitting}
      title="Refund"
      description="Choose what is coming back, or type an amount. The maximums come from the order."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={amount <= 0 || overMax}
            isLoading={isSubmitting}
          >
            {amount > 0 && data
              ? `Refund ${formatMoney({ amount, currency: data.currency })}`
              : 'Refund'}
          </Button>
        </>
      }
    >
      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data ? (
          <div className="flex flex-col gap-4">
            {error ? <Alert tone="danger">{error}</Alert> : null}

            {data.payments.length === 0 ? (
              <Alert tone="warning">
                No captured payment on this order, so there is nothing to refund yet.
              </Alert>
            ) : null}

            <LineTable
              data={data}
              quantities={quantities}
              onChange={(next) => {
                // Changing what is coming back re-derives the amount: an
                // override typed a moment ago is no longer what the operator
                // means once the units change underneath it.
                setOverride(null)
                setQuantities(next)
              }}
            />

            {data.shippingTotal.amount > 0 ? (
              <Checkbox
                checked={refundShipping}
                label={`Refund shipping (${formatMoney(data.shippingTotal)})`}
                description="Whether postage comes back is a shop's own policy, so it is asked rather than assumed."
                onChange={(event) => {
                  setOverride(null)
                  setRefundShipping(event.target.checked)
                }}
              />
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Amount"
                hint={`Up to ${formatMoney({ amount: max, currency: data.currency })}.`}
                error={overMax ? 'More than remains refundable.' : undefined}
              >
                <MoneyInput
                  currency={data.currency}
                  value={amount}
                  onValueChange={(next) => setOverride(next)}
                />
              </Field>

              <Field label="Reason" hint="Recorded on the refund and shown in the timeline.">
                <Select
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  options={reasons}
                />
              </Field>

              {data.payments.length > 1 ? (
                <Field label="Refund against" className="sm:col-span-2">
                  <Select
                    value={chosenPayment?.id ?? ''}
                    onChange={(event) => setPaymentId(event.target.value)}
                    options={data.payments.map((payment) => ({
                      value: payment.id,
                      label: `${payment.method} — ${formatMoney(payment.refundable)} left`,
                    }))}
                  />
                </Field>
              ) : null}
            </div>

            <Checkbox
              checked={restock}
              label="Put these units back on the shelf"
              description="Only tick this if the goods are back and can be sold again. Damaged returns usually cannot."
              onChange={(event) => setRestock(event.target.checked)}
            />
          </div>
        ) : null}
      </QueryBoundary>
    </Modal>
  )
}

function LineTable({
  data,
  quantities,
  onChange,
}: {
  data: Refundable
  quantities: Record<string, number>
  onChange: (next: Record<string, number>) => void
}) {
  return (
    <div className="scrollbar-thin border-line overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-line bg-surface-sunken border-b">
            <th className="text-muted px-3 py-2 text-left text-xs font-semibold">Item</th>
            <th className="text-muted px-3 py-2 text-right text-xs font-semibold">Each</th>
            <th className="text-muted px-3 py-2 text-right text-xs font-semibold">Refundable</th>
            <th className="text-muted px-3 py-2 text-right text-xs font-semibold">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line) => (
            <tr key={line.orderItemId} className="border-line border-b last:border-0">
              <td className="px-3 py-2">
                <span className="text-ink block font-medium">{line.productTitle}</span>
                {line.sku ? (
                  <span className="text-faint block font-mono text-xs">{line.sku}</span>
                ) : null}
              </td>
              <td className="text-muted tabular px-3 py-2 text-right">
                {formatMoney(line.perUnit)}
              </td>
              <td className="text-muted tabular px-3 py-2 text-right">
                {line.refundableQuantity} of {line.quantity}
              </td>
              <td className="px-3 py-2 text-right">
                <Input
                  type="number"
                  size="sm"
                  min={0}
                  max={line.refundableQuantity}
                  className="w-20"
                  aria-label={`Quantity to refund for ${line.productTitle}`}
                  disabled={line.refundableQuantity === 0}
                  value={String(quantities[line.orderItemId] ?? '')}
                  onChange={(event) => {
                    const raw = Number(event.target.value)
                    // Clamped here as well as on the server: an input that lets
                    // somebody type 99 and then refuses the whole request is a
                    // worse way to say the same thing.
                    const next = Number.isFinite(raw)
                      ? Math.max(0, Math.min(line.refundableQuantity, Math.floor(raw)))
                      : 0
                    onChange({ ...quantities, [line.orderItemId]: next })
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
