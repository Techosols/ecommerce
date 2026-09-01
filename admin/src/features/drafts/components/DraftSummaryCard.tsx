import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { formatMoney } from '@/lib/format'
import { deliveryEstimate, isReady } from './draftLabels'
import type { DraftDetail, DraftPatch } from '../types/drafts.types'
import type { Money } from '@/types/api'

/**
 * What it comes to, and the button that makes it real.
 *
 * Every figure on this card was computed by the server, by the same code that
 * prices a storefront checkout — the admin does not multiply, apportion or add
 * anything up. That is the whole reason a staff member can read the total down
 * the phone: it is the number the customer will be charged, not an estimate
 * assembled in a browser.
 *
 * `blockers` are the server's answer to "can this be placed", shown verbatim.
 * Repeating those checks here would be a second rule free to disagree with the
 * one that actually governs placement.
 */
export function DraftSummaryCard({
  draft,
  onSave,
  onPlace,
  isSaving,
  isPlacing,
  canPlace,
}: {
  draft: DraftDetail
  onSave: (patch: DraftPatch) => void
  onPlace: () => void
  isSaving: boolean
  isPlacing: boolean
  canPlace: boolean
}) {
  const [code, setCode] = useState(draft.discountCode ?? '')
  const ready = isReady(draft)

  if (draft.placedOrderId) {
    return (
      <Card>
        <CardHeader title="Placed" description="This quote became an order." />
        <CardBody className="flex flex-col gap-3">
          <Row label="Total quoted" value={draft.total} strong />
          <Link
            to={`/orders/${draft.placedOrderId}`}
            className="text-brand-600 text-sm hover:underline"
          >
            Open the order →
          </Link>
          <p className="text-faint text-xs">
            The draft is kept as the record of what was quoted and by whom.
          </p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="What it comes to"
        description="Priced by checkout itself, so this is what will be charged."
      />

      <CardBody className="flex flex-col gap-4">
        <Field label="Delivery">
          <Select
            value={draft.shippingMethodId ?? ''}
            disabled={isSaving || draft.shippingOptions.length === 0}
            onChange={(event) => onSave({ shippingMethodId: event.target.value || null })}
            options={[
              { value: '', label: 'Not chosen' },
              ...draft.shippingOptions.map((option) => ({
                value: option.methodId,
                label: [
                  option.name,
                  formatMoney(option.amount),
                  deliveryEstimate(option),
                ]
                  .filter(Boolean)
                  .join(' — '),
              })),
            ]}
          />
        </Field>

        {draft.shippingOptions.length === 0 ? (
          <p className="text-faint -mt-2 text-xs">
            Delivery is rated against the address. Add one to see the options.
          </p>
        ) : null}

        <Field label="Payment">
          <Select
            value={draft.paymentMethod}
            disabled={isSaving}
            onChange={(event) => onSave({ paymentMethod: event.target.value })}
            options={
              draft.paymentMethods.length > 0
                ? draft.paymentMethods.map((method) => ({
                    value: method.key,
                    label:
                      method.fee.amount > 0
                        ? `${method.label} (+${formatMoney(method.fee)})`
                        : method.label,
                  }))
                : [{ value: draft.paymentMethod, label: draft.paymentMethod }]
            }
          />
        </Field>

        <Field label="Discount code" hint="Validated afresh when the order is placed.">
          <div className="flex gap-2">
            <Input
              value={code}
              disabled={isSaving}
              placeholder="None"
              onChange={(event) => setCode(event.target.value)}
            />
            <Button
              disabled={isSaving || code.trim() === (draft.discountCode ?? '')}
              onClick={() => onSave({ discountCode: code.trim() || null })}
            >
              Apply
            </Button>
          </div>
        </Field>

        <div className="border-line flex flex-col gap-2 border-t pt-4">
          <Row label="Items" value={draft.subtotal} />
          {draft.discountTotal.amount > 0 ? (
            <Row label="Discount" value={draft.discountTotal} negative />
          ) : null}
          <Row label="Delivery" value={draft.shippingTotal} />
          {draft.paymentFee.amount > 0 ? <Row label="Payment fee" value={draft.paymentFee} /> : null}
          <Row label="Tax" value={draft.taxTotal} />
          <div className="border-line mt-1 border-t pt-2">
            <Row label="Total" value={draft.total} strong />
          </div>
        </div>

        {draft.blockers.length > 0 ? (
          <Alert tone="warning" title="Not ready yet">
            <ul className="list-inside list-disc space-y-0.5">
              {draft.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </CardBody>

      <CardFooter>
        <span className="text-faint text-xs">
          Stock is reserved at this point, not before.
        </span>
        <Button
          variant="primary"
          isLoading={isPlacing}
          disabled={!ready || !canPlace || isSaving}
          onClick={onPlace}
        >
          Place the order
        </Button>
      </CardFooter>
    </Card>
  )
}

function Row({
  label,
  value,
  strong,
  negative,
}: {
  label: string
  value: Money
  strong?: boolean
  negative?: boolean
}) {
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
              ? 'text-positive tabular text-sm'
              : 'text-ink tabular text-sm'
        }
      >
        {negative ? '−' : ''}
        {formatMoney(value)}
      </span>
    </div>
  )
}
