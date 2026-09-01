import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { useCreateMethod, useUpdateMethod } from '../hooks/shipping.hooks'
import type { RateType, ShippingMethod } from '../types/shipping.types'

export interface MethodDialogProps {
  zoneId: string
  zoneName: string
  /** `null` creates a new method in this zone. */
  method: ShippingMethod | null
  onClose: () => void
}

const RATE_TYPES: Array<{ value: RateType; label: string }> = [
  { value: 'flat', label: 'One price, whatever it weighs' },
  { value: 'free', label: 'Free' },
  { value: 'weight_based', label: 'A price per kilogram' },
]

/** Grams in the API, kilograms in the field: nobody types 2000 for 2 kg. */
function toKg(grams: number | null): string {
  return grams === null ? '' : String(grams / 1000)
}

function toGrams(kg: string): number | null {
  if (kg.trim() === '') return null
  const value = Number(kg)
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null
}

/**
 * One delivery method.
 *
 * The dialog's job is to keep three things from being confused, because they
 * are three different mechanisms that all look like "how much":
 *
 *   • **Rate type** — what the price means. Flat is the price; per-kilogram
 *     multiplies it by every started kilogram; free is free.
 *   • **Free over** — a threshold that beats the rate type entirely. "Free
 *     delivery over £50" is true whichever way the rate is computed.
 *   • **Weight band** — not a price at all. It decides whether this method is
 *     *offered*, so a parcel outside the band simply does not see it.
 *
 * Each gets its own labelled group and a sentence saying which of the three it
 * is, rather than four number fields in a row.
 */
export function MethodDialog({ zoneId, zoneName, method, onClose }: MethodDialogProps) {
  const { toast } = useToast()
  const currency = useStoreCurrency()
  const create = useCreateMethod()
  const update = useUpdateMethod()

  const [name, setName] = useState(method?.name ?? 'Standard')
  const [description, setDescription] = useState(method?.description ?? '')
  const [rateType, setRateType] = useState<RateType>(method?.rateType ?? 'flat')
  const [priceCents, setPriceCents] = useState<number | null>(method?.priceCents ?? 0)
  const [freeOver, setFreeOver] = useState<number | null>(method?.freeOverSubtotalCents ?? null)
  const [minWeight, setMinWeight] = useState(toKg(method?.minWeightGrams ?? null))
  const [maxWeight, setMaxWeight] = useState(toKg(method?.maxWeightGrams ?? null))
  const [daysMin, setDaysMin] = useState(
    method?.estimatedDaysMin === null || method?.estimatedDaysMin === undefined
      ? ''
      : String(method.estimatedDaysMin),
  )
  const [daysMax, setDaysMax] = useState(
    method?.estimatedDaysMax === null || method?.estimatedDaysMax === undefined
      ? ''
      : String(method.estimatedDaysMax),
  )
  const [isActive, setActive] = useState(method?.isActive ?? true)

  const pending = create.isPending || update.isPending
  const min = toGrams(minWeight)
  const max = toGrams(maxWeight)
  const bandBackwards = min !== null && max !== null && min > max
  const daysBackwards = daysMin !== '' && daysMax !== '' && Number(daysMin) > Number(daysMax)
  const ready = name.trim() !== '' && !bandBackwards && !daysBackwards

  function submit() {
    if (!ready || pending) return

    const number = (value: string) => (value.trim() === '' ? null : Number(value))
    const body = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      rateType,
      // Free is free: sending a price with it would leave a number on the
      // record that nothing uses and everyone reads.
      priceCents: rateType === 'free' ? 0 : (priceCents ?? 0),
      freeOverSubtotalCents: rateType === 'free' ? null : freeOver,
      minWeightGrams: min,
      maxWeightGrams: max,
      estimatedDaysMin: number(daysMin),
      estimatedDaysMax: number(daysMax),
    }

    const onSuccess = () => {
      toast({ tone: 'success', title: method ? 'Method updated' : 'Method added' })
      onClose()
    }
    const onError = (error: unknown) =>
      toast({ tone: 'error', title: 'Could not save the method', description: messageOf(error) })

    if (method) {
      update.mutate({ id: method.id, patch: { ...body, isActive } }, { onSuccess, onError })
      return
    }
    // `isActive` is not part of the create schema — a new method is offered
    // from the moment it exists, and the toggle below only appears on an edit.
    create.mutate({ zoneId, ...body }, { onSuccess, onError })
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={method ? `Edit ${method.name}` : `Add a method to ${zoneName}`}
      description="What a shopper in this zone is offered at checkout."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={pending} onClick={submit}>
            {method ? 'Save method' : 'Add method'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required hint="The shopper sees this at checkout.">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field label="Delivery estimate" hint="Shown beside the price. Days, from and to.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={365}
                aria-label="Fastest, in days"
                placeholder="2"
                value={daysMin}
                onChange={(event) => setDaysMin(event.target.value)}
              />
              <span className="text-muted text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={365}
                aria-label="Slowest, in days"
                placeholder="4"
                invalid={daysBackwards}
                value={daysMax}
                onChange={(event) => setDaysMax(event.target.value)}
              />
            </div>
          </Field>
        </div>

        <Field label="Description" hint="A line of detail — “Tracked, signed for”.">
          <Input
            value={description}
            maxLength={300}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <fieldset className="border-line flex flex-col gap-4 rounded-md border p-3">
          <legend className="text-ink px-1 text-sm font-medium">What it costs</legend>

          <Field label="Charged as">
            <Select
              value={rateType}
              onChange={(event) => setRateType(event.target.value as RateType)}
              options={RATE_TYPES}
            />
          </Field>

          {rateType !== 'free' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={rateType === 'weight_based' ? 'Price per kilogram' : 'Price'}
                hint={
                  rateType === 'weight_based'
                    ? 'Couriers charge by the started kilogram, so 1.2 kg costs two.'
                    : undefined
                }
              >
                <MoneyInput currency={currency} value={priceCents} onValueChange={setPriceCents} />
              </Field>

              <Field label="Free over" hint="Blank for no threshold. It beats the price above.">
                <MoneyInput currency={currency} value={freeOver} onValueChange={setFreeOver} />
              </Field>
            </div>
          ) : (
            <p className="text-muted text-sm">Nothing is charged, whatever the basket weighs.</p>
          )}
        </fieldset>

        <fieldset className="border-line flex flex-col gap-3 rounded-md border p-3">
          <legend className="text-ink px-1 text-sm font-medium">When it is offered</legend>

          <Field
            label="Parcel weight"
            hint="Kilograms. Blank at either end means no limit that way."
            error={bandBackwards ? 'The lightest is heavier than the heaviest.' : undefined}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                step={0.1}
                aria-label="From, in kilograms"
                placeholder="0"
                value={minWeight}
                onChange={(event) => setMinWeight(event.target.value)}
              />
              <span className="text-muted text-sm">to</span>
              <Input
                type="number"
                min={0}
                step={0.1}
                aria-label="To, in kilograms"
                placeholder="No limit"
                invalid={bandBackwards}
                value={maxWeight}
                onChange={(event) => setMaxWeight(event.target.value)}
              />
            </div>
          </Field>

          {min !== null || max !== null ? (
            <Alert tone="info">
              A basket outside this band is not offered this method at all. If nothing else covers
              that weight, the shopper is told the store does not deliver to them.
            </Alert>
          ) : null}
        </fieldset>

        {method ? (
          <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-ink text-sm font-medium">Offered at checkout</p>
              <p className="text-muted mt-0.5 text-xs">
                Off keeps the method on the rate card without quoting it to anybody.
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setActive} label="Offered at checkout" />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
