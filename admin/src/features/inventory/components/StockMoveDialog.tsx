import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import {
  useAdjustStock,
  useLocations,
  useStocktake,
  useTransferStock,
} from '../hooks/inventory.hooks'
import { OPERATOR_LABELS } from './inventoryLabels'
import {
  OPERATOR_REASONS,
  type InventoryItemDetail,
  type OperatorReason,
} from '../types/inventory.types'

export type StockMoveKind = 'adjust' | 'count' | 'transfer'

export interface StockMoveDialogProps {
  kind: StockMoveKind | null
  item: InventoryItemDetail
  onClose: () => void
}

const TITLES: Record<StockMoveKind, string> = {
  adjust: 'Adjust stock',
  count: 'Record a stock count',
  transfer: 'Transfer stock',
}

const DESCRIPTIONS: Record<StockMoveKind, string> = {
  adjust: 'Move stock by an amount, and say why. The reason is what the ledger keeps.',
  count: 'What you counted on the shelf. The correction is worked out from it.',
  transfer: 'Move stock between locations. Nothing is created or destroyed.',
}

/**
 * The three ways stock moves, in one dialog.
 *
 * One component because they share a target, a location and a note, and because
 * the distinction that matters is not which form you are on — it is what you
 * send:
 *
 *   • **Adjust** sends a delta. "Two were damaged" is `-2`, and the ledger
 *     keeps the reason.
 *   • **Count** sends the number you counted, never a delta. The server
 *     subtracts against what it currently holds, so a count taken off a shelf
 *     cannot become the wrong movement because the browser did the arithmetic
 *     against a figure that was already stale when the page rendered. That is
 *     the whole reason stocktake is its own endpoint.
 *   • **Transfer** sends a quantity and two locations.
 *
 * Nothing here computes a resulting quantity. The response carries the new
 * totals, and they are the server's.
 */
export function StockMoveDialog({ kind, item, onClose }: StockMoveDialogProps) {
  const { toast } = useToast()
  const locations = useLocations()
  const adjust = useAdjustStock()
  const count = useStocktake()
  const transfer = useTransferStock()

  const [locationId, setLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [reason, setReason] = useState<OperatorReason>('receive')
  const [note, setNote] = useState('')

  const active = (locations.data ?? []).filter((location) => location.isActive)
  const pending = adjust.isPending || count.isPending || transfer.isPending

  function close() {
    setLocationId('')
    setToLocationId('')
    setAmount('')
    setDirection('in')
    setReason('receive')
    setNote('')
    onClose()
  }

  const quantity = Number(amount)
  const isValidQuantity = amount !== '' && Number.isInteger(quantity) && quantity >= 0
  const ready =
    kind === 'transfer'
      ? isValidQuantity &&
        quantity > 0 &&
        locationId !== '' &&
        toLocationId !== '' &&
        locationId !== toLocationId
      : isValidQuantity && (kind === 'count' || quantity > 0)

  /**
   * The level being counted, so the dialog can show what it is correcting.
   *
   * Blank means the default location — the same thing the server will resolve
   * it to — so the comparison has to resolve it too. Matching only an explicit
   * choice would leave the commonest case, a single-location shop counting its
   * one shelf, with nothing to check the number against.
   */
  const effectiveLocationId =
    locationId || (locations.data ?? []).find((entry) => entry.isDefault)?.id || ''
  const level = item.levels.find((entry) => entry.locationId === effectiveLocationId)

  function submit() {
    if (!ready || pending || !kind) return

    const shared = {
      inventoryItemId: item.id,
      ...(locationId ? { locationId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }

    const onSuccess = () => {
      toast({ tone: 'success', title: 'Stock updated' })
      close()
    }
    const onError = (error: unknown) =>
      toast({ tone: 'error', title: 'Could not move the stock', description: messageOf(error) })

    if (kind === 'adjust') {
      adjust.mutate(
        { ...shared, delta: direction === 'out' ? -quantity : quantity, reason },
        { onSuccess, onError },
      )
      return
    }
    if (kind === 'count') {
      count.mutate({ ...shared, countedOnHand: quantity }, { onSuccess, onError })
      return
    }
    transfer.mutate(
      {
        inventoryItemId: item.id,
        fromLocationId: locationId,
        toLocationId,
        quantity,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      { onSuccess, onError },
    )
  }

  if (!kind) return null

  return (
    <Modal
      isOpen
      onClose={close}
      title={TITLES[kind]}
      description={DESCRIPTIONS[kind]}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={pending} onClick={submit}>
            {kind === 'count' ? 'Record count' : kind === 'transfer' ? 'Transfer' : 'Adjust stock'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label={kind === 'transfer' ? 'From' : 'Location'}
          hint={
            kind === 'transfer' ? undefined : 'Left blank, the store’s default location is used.'
          }
        >
          <Select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            placeholder={kind === 'transfer' ? 'Choose a location…' : 'Default location'}
            options={active.map((location) => ({ value: location.id, label: location.name }))}
          />
        </Field>

        {kind === 'transfer' ? (
          <Field
            label="To"
            error={
              locationId !== '' && locationId === toLocationId
                ? 'Choose a different location.'
                : undefined
            }
          >
            <Select
              value={toLocationId}
              onChange={(event) => setToLocationId(event.target.value)}
              placeholder="Choose a location…"
              options={active
                .filter((location) => location.id !== locationId)
                .map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
        ) : null}

        {kind === 'adjust' ? (
          <Field label="Direction">
            <Select
              value={direction}
              onChange={(event) => setDirection(event.target.value as 'in' | 'out')}
              options={[
                { value: 'in', label: 'Add stock' },
                { value: 'out', label: 'Remove stock' },
              ]}
            />
          </Field>
        ) : null}

        <Field
          label={kind === 'count' ? 'Counted on hand' : 'Quantity'}
          required
          hint={
            kind === 'count'
              ? 'The number on the shelf. The difference is worked out for you.'
              : undefined
          }
        >
          <Input
            type="number"
            min={kind === 'count' ? 0 : 1}
            step={1}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        {/* Shown, not sent: the correction is the server's to compute, and this
            is only here so the operator can see whether the count is a
            surprise before committing to it. */}
        {kind === 'count' && level && isValidQuantity ? (
          <Alert tone={quantity === level.onHand ? 'info' : 'warning'}>
            {/* Named, because a count is per location: "currently 18" beside a
                page totalling 24 across two shelves reads as a bug otherwise. */}
            {quantity === level.onHand
              ? `That matches the ${formatNumber(level.onHand)} recorded at ${level.locationName}.`
              : `${level.locationName} currently holds ${formatNumber(level.onHand)}. Recording this
                 count corrects it by ${quantity > level.onHand ? '+' : '−'}${Math.abs(quantity - level.onHand)}.`}
          </Alert>
        ) : null}

        {kind === 'adjust' ? (
          <Field
            label="Reason"
            required
            hint="Kept on the ledger for good; it cannot be edited later."
          >
            <Select
              value={reason}
              onChange={(event) => setReason(event.target.value as OperatorReason)}
              options={OPERATOR_REASONS.filter((entry) => entry !== 'stocktake').map((entry) => ({
                value: entry,
                label: OPERATOR_LABELS[entry],
              }))}
            />
          </Field>
        ) : null}

        <Field label="Note">
          <Textarea
            rows={2}
            maxLength={500}
            value={note}
            placeholder="Anything the next person should know."
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>

        {kind === 'transfer' ? (
          <Alert tone="info">
            A transfer writes two movements — out of one location and into the other — so the total
            across the shop is unchanged and both ledgers explain themselves.
          </Alert>
        ) : null}
      </div>
    </Modal>
  )
}
