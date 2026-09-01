import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { messageOf } from '@/lib/api/errors'
import { useCreateDiscount } from '../hooks/discounts.hooks'
import { percentToBps } from './discountLabels'
import type { DiscountType } from '../types/discounts.types'

export interface CreateDiscountDialogProps {
  onClose: () => void
}

/**
 * A new code, and only what cannot be changed later.
 *
 * Deliberately short. The code and the type are fixed once a discount exists —
 * an order citing SUMMER25 as a percentage has to keep meaning that — so those
 * are the two decisions worth making carefully here, and everything else
 * (schedule, limits, scope, minimum) is set on the detail page where there is
 * room to explain it.
 */
export function CreateDiscountDialog({ onClose }: CreateDiscountDialogProps) {
  const { toast } = useToast()
  const navigate = useNavigate()
  const currency = useStoreCurrency()
  const create = useCreateDiscount()

  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<DiscountType>('percentage')
  const [percent, setPercent] = useState('10')
  const [amountCents, setAmountCents] = useState<number | null>(500)

  const codeIsValid = /^[A-Za-z0-9_-]{3,64}$/.test(code.trim())
  const value = type === 'percentage' ? percentToBps(percent) : (amountCents ?? 0)
  const ready = codeIsValid && title.trim() !== '' && (type === 'free_shipping' || value > 0)

  function submit() {
    if (!ready || create.isPending) return
    create.mutate(
      {
        code: code.trim().toUpperCase(),
        title: title.trim(),
        type,
        // Free shipping carries no value at all — sending one would leave a
        // number on the record that nothing reads and everybody does.
        ...(type === 'free_shipping' ? {} : { value }),
      },
      {
        onSuccess: (discount) => {
          toast({ tone: 'success', title: 'Discount created' })
          onClose()
          // Straight to the detail page: the code exists but has no schedule,
          // no limits and no scope yet, and that is where they are set.
          void navigate(`/discounts/${discount.id}`)
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not create it', description: messageOf(error) }),
      },
    )
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="New discount"
      description="The code and what it takes off. Everything else is set next."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={create.isPending} onClick={submit}>
            Create discount
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Code"
          required
          hint="Letters, numbers, hyphens and underscores. Customers type this."
          error={
            code !== '' && !codeIsValid
              ? 'Three characters or more, and nothing a customer cannot type from a poster.'
              : undefined
          }
        >
          <Input
            value={code}
            placeholder="SUMMER25"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </Field>

        <Field label="Name" required hint="For your own reference, and on the order.">
          <Input
            value={title}
            placeholder="Summer sale"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field label="Takes off" required>
          <Select
            value={type}
            onChange={(event) => setType(event.target.value as DiscountType)}
            options={[
              { value: 'percentage', label: 'A percentage of the order' },
              { value: 'fixed_amount', label: 'A fixed amount' },
              { value: 'free_shipping', label: 'The delivery charge' },
            ]}
          />
        </Field>

        {type === 'percentage' ? (
          <Field label="Percent off" required>
            <div className="relative max-w-40">
              <Input
                type="number"
                min={0.01}
                max={100}
                step={0.01}
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
                className="pr-7"
              />
              <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">
                %
              </span>
            </div>
          </Field>
        ) : null}

        {type === 'fixed_amount' ? (
          <Field label="Amount off" required>
            <div className="max-w-40">
              <MoneyInput currency={currency} value={amountCents} onValueChange={setAmountCents} />
            </div>
          </Field>
        ) : null}

        <Alert tone="info">
          The code and what it takes off cannot be changed afterwards — an order that used
          {code.trim() ? ` ${code.trim().toUpperCase()}` : ' a code'} has to keep meaning what it
          meant. Everything else can.
        </Alert>
      </div>
    </Modal>
  )
}
