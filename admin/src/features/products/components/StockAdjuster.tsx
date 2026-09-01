import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import { useAdjustStock } from '../hooks/products.hooks'
import { ADJUSTMENT_REASONS, type AdjustmentReason, type VariantInventory } from '../types/products.types'

const reasonLabels: Record<AdjustmentReason, string> = {
  receive: 'Received stock',
  manual_adjustment: 'Manual adjustment',
  stocktake: 'Stocktake',
  damage: 'Damaged',
  waste: 'Waste',
  return: 'Returned',
  correction: 'Correction',
}

export interface StockAdjusterProps {
  variantId: string
  inventory: VariantInventory
  disabled?: boolean
}

/**
 * Moving stock, the way the ledger records it.
 *
 * The server takes a **delta and a reason**, not a new total — every movement
 * is an entry someone can later explain. So the operator says "+12, received"
 * rather than typing a number over the old one, and the resulting quantity is
 * the ledger's answer rather than the browser's arithmetic.
 *
 * The preview beside the input is the one exception, and it is labelled as a
 * preview: it helps someone check they typed what they meant before committing.
 */
export function StockAdjuster({ variantId, inventory, disabled = false }: StockAdjusterProps) {
  const { toast } = useToast()
  const adjust = useAdjustStock()
  const [isOpen, setIsOpen] = useState(false)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState<AdjustmentReason>('receive')
  const [note, setNote] = useState('')

  const parsed = Number(quantity)
  const isValid = Number.isInteger(parsed) && parsed > 0
  const delta = direction * (isValid ? parsed : 0)
  const projected = inventory.totals.onHand + delta

  function close() {
    setIsOpen(false)
    setQuantity('')
    setNote('')
  }

  function submit() {
    if (!isValid || adjust.isPending) return
    adjust.mutate(
      { variantId, delta, reason, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (result) => {
          toast({
            tone: 'success',
            title: 'Stock updated',
            description: `${formatNumber(result.available)} available, ${formatNumber(result.onHand)} on hand.`,
          })
          close()
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not move stock', description: messageOf(error) }),
      },
    )
  }

  return (
    <>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setIsOpen(true)}>
        Adjust
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={adjust.isPending ? () => undefined : close}
        dismissible={!adjust.isPending}
        title="Adjust stock"
        description="Stock moves by an amount, with a reason — the ledger records the movement, not just the total."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={adjust.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!isValid}
              isLoading={adjust.isPending}
            >
              Save adjustment
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-sunken flex items-center justify-between rounded-lg px-3 py-2 text-sm">
            <span className="text-muted">On hand now</span>
            <span className="text-ink tabular font-semibold">
              {formatNumber(inventory.totals.onHand)}
            </span>
          </div>

          <Field label="Change">
            <div className="flex items-stretch gap-2">
              <div className="border-line-strong flex overflow-hidden rounded-lg border">
                <button
                  type="button"
                  aria-label="Remove stock"
                  aria-pressed={direction === -1}
                  onClick={() => setDirection(-1)}
                  className={
                    direction === -1
                      ? 'bg-danger px-3 text-white'
                      : 'text-muted hover:bg-surface-hover px-3'
                  }
                >
                  <Minus className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Add stock"
                  aria-pressed={direction === 1}
                  onClick={() => setDirection(1)}
                  className={
                    direction === 1
                      ? 'bg-positive px-3 text-white'
                      : 'text-muted hover:bg-surface-hover px-3'
                  }
                >
                  <Plus className="size-4" />
                </button>
              </div>

              <Input
                type="number"
                min={1}
                inputMode="numeric"
                aria-label="Quantity"
                placeholder="0"
                value={quantity}
                data-autofocus
                onChange={(event) => setQuantity(event.target.value)}
                className="flex-1"
              />
            </div>
          </Field>

          {isValid ? (
            <p className="text-muted text-xs">
              Preview: on hand becomes{' '}
              <span className="text-ink tabular font-medium">{formatNumber(projected)}</span>
              {projected < 0 ? (
                <span className="text-danger"> — the server will refuse a negative level.</span>
              ) : null}
            </p>
          ) : null}

          <Field label="Reason" hint="Recorded on the movement, and visible in the stock history.">
            <Select
              value={reason}
              onChange={(event) => setReason(event.target.value as AdjustmentReason)}
              options={ADJUSTMENT_REASONS.map((value) => ({
                value,
                label: reasonLabels[value],
              }))}
            />
          </Field>

          <Field label="Note" hint="Optional.">
            <Input
              value={note}
              maxLength={500}
              placeholder="Delivery #4821"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
