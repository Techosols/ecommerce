import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { formatMoney } from '@/lib/format'
import type { PaymentProof } from '../types/payments.types'

/** The reasons a receipt is actually turned down, in the order they happen. */
const PRESETS = [
  'The amount does not match your order total.',
  'We could not find this payment in our account.',
  'The screenshot is not readable — please send a clearer one.',
  'This receipt is for a different order.',
] as const

export interface RejectProofDialogProps {
  proof: PaymentProof | null
  isSaving?: boolean
  onCancel: () => void
  onConfirm: (note: string) => void
}

/**
 * Turning a receipt down, with a reason the customer will read.
 *
 * The note is mandatory here, in the API and in the database, and that is
 * deliberate rather than defensive: somebody who believes they have paid and is
 * told only "rejected" has no idea whether to send the money again, send a
 * better photograph, or ring up. Every one of those is a different next step,
 * and only the shop knows which.
 *
 * The presets exist because the four real reasons are always the same four, and
 * a required free-text box with no starting point is how you get "no" typed
 * forty times. They fill the field rather than submitting, so the reviewer can
 * add the detail that matters — an amount, an order number.
 */
export function RejectProofDialog({
  proof,
  isSaving = false,
  onCancel,
  onConfirm,
}: RejectProofDialogProps) {
  const [note, setNote] = useState('')

  // A fresh note per receipt: carrying the last one over is how the wrong
  // customer gets told their screenshot was illegible.
  useEffect(() => {
    if (proof) setNote('')
  }, [proof])

  const trimmed = note.trim()

  return (
    <Modal
      isOpen={proof !== null}
      onClose={onCancel}
      title="Reject this receipt"
      description={
        proof?.order
          ? `${proof.order.orderNumber} · ${formatMoney(proof.order.total)}. The order stays unpaid and the customer can send another.`
          : 'The order stays unpaid and the customer can send another.'
      }
      size="md"
      footer={
        <>
          <Button onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!trimmed || isSaving}
            onClick={() => onConfirm(trimmed)}
          >
            {isSaving ? 'Rejecting…' : 'Reject receipt'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setNote(preset)}
              className="ring-line-strong text-ink-soft hover:bg-surface-hover rounded-full px-2.5 py-1 text-xs ring-1 ring-inset"
            >
              {preset.replace(/\.$/, '')}
            </button>
          ))}
        </div>

        <Field
          label="Reason"
          hint="The customer sees this. Say what would make the next attempt succeed."
        >
          <Textarea
            rows={3}
            value={note}
            maxLength={1000}
            autoFocus
            disabled={isSaving}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
