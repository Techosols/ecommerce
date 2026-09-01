import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { formatMoney } from '@/lib/format'
import type { Money } from '@/types/api'
import type { OrderDetail } from '../types/orders.types'

function Line({
  label,
  value,
  hint,
  tone = 'normal',
}: {
  label: string
  value: Money
  hint?: string
  tone?: 'normal' | 'subtract' | 'total' | 'net'
}) {
  return (
    <div
      className={
        tone === 'total' || tone === 'net'
          ? 'border-line flex items-baseline justify-between gap-4 border-t pt-2.5'
          : 'flex items-baseline justify-between gap-4'
      }
    >
      <span
        className={
          tone === 'total' || tone === 'net' ? 'text-ink text-sm font-semibold' : 'text-muted text-sm'
        }
      >
        {label}
        {hint ? <span className="text-faint ml-1.5 text-xs">{hint}</span> : null}
      </span>
      <span
        className={
          tone === 'subtract'
            ? 'text-danger tabular text-sm'
            : tone === 'total' || tone === 'net'
              ? 'text-ink tabular text-base font-semibold'
              : 'text-ink tabular text-sm'
        }
      >
        {tone === 'subtract' ? '−' : ''}
        {formatMoney(value)}
      </span>
    </div>
  )
}

/**
 * The totals as a derivation, not a number.
 *
 * Every figure here comes from the server; nothing is added up in the browser.
 * That is not fussiness — the order's arithmetic is enforced by a database
 * constraint, and a second calculation here could only ever agree or be wrong.
 *
 * What the page *does* do is show the working, so an operator on the phone to a
 * customer can say where each figure came from: subtotal, less discount, plus
 * shipping, plus tax, is the total; less what has been refunded is what the shop
 * actually kept.
 */
export function OrderTotalsCard({ order }: { order: OrderDetail }) {
  const { totals } = order
  const refunded = totals.refundedTotal.amount > 0
  const net = { amount: totals.total.amount - totals.refundedTotal.amount, currency: order.currency }

  const discountHint = order.discounts.map((discount) => discount.code).join(', ')

  return (
    <Card>
      <CardHeader title="Payment summary" />
      <CardBody className="flex flex-col gap-2.5">
        <Line label="Subtotal" value={totals.subtotal} />

        {totals.discountTotal.amount > 0 ? (
          <Line
            label="Discount"
            {...(discountHint ? { hint: discountHint } : {})}
            value={totals.discountTotal}
            tone="subtract"
          />
        ) : null}

        <Line
          label="Shipping"
          {...(order.shippingMethodName ? { hint: order.shippingMethodName } : {})}
          value={totals.shippingTotal}
        />

        {totals.taxTotal.amount > 0 ? <Line label="Tax" value={totals.taxTotal} /> : null}

        {totals.paymentFee.amount > 0 ? (
          <Line label="Payment fee" hint={order.paymentMethod} value={totals.paymentFee} />
        ) : null}

        <Line label="Total" value={totals.total} tone="total" />

        {refunded ? (
          <>
            <Line label="Refunded" value={totals.refundedTotal} tone="subtract" />
            <Line label="Net" value={net} tone="net" />
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}
