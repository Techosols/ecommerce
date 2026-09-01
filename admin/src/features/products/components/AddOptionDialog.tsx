import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { TagsInput } from '@/components/ui/TagsInput'
import { useToast } from '@/components/ui/toast.context'
import { isApiError, messageOf } from '@/lib/api/errors'
import { useAddOption } from '../hooks/products.hooks'
import type { ProductOption } from '../types/products.types'

export interface AddOptionDialogProps {
  productId: string
  options: ProductOption[]
  /** Live variants only — the count the merchant is being asked about. */
  variantCount: number
  isOpen: boolean
  onClose: () => void
}

/**
 * A new axis of variation — Colour, Material, Storage, Length, anything.
 *
 * The one question this dialog exists to ask is the third field. Every variant
 * already on the product has to select a value on the new option, and no
 * default the server could invent would be right: a merchant adding Colour to a
 * product they have only ever sold in black means something specific by it. So
 * the form asks, plainly, and sends the answer as `appliesToExisting`.
 *
 * Nothing else changes. No variants are created — which combinations are worth
 * stocking is the next decision, made in the Variants card.
 */
export function AddOptionDialog({
  productId,
  options,
  variantCount,
  isOpen,
  onClose,
}: AddOptionDialogProps) {
  const { toast } = useToast()
  const add = useAddOption(productId)

  const [name, setName] = useState('')
  const [values, setValues] = useState<string[]>([])
  const [applies, setApplies] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The chosen value has to stay one of the values; deleting a chip that was
  // selected falls back to the first rather than sending something that is no
  // longer on the list.
  const chosen = values.includes(applies) ? applies : (values[0] ?? '')
  const taken = new Set(options.map((option) => option.name.toLowerCase()))
  const duplicate = taken.has(name.trim().toLowerCase())
  const ready = name.trim() !== '' && values.length > 0 && !duplicate

  function close() {
    setName('')
    setValues([])
    setApplies('')
    setError(null)
    onClose()
  }

  async function submit() {
    if (!ready || add.isPending) return
    try {
      await add.mutateAsync({
        name: name.trim(),
        values,
        appliesToExisting: chosen,
      })
      toast({
        tone: 'success',
        title: `${name.trim()} added`,
        description:
          variantCount > 0
            ? `Existing variants now read “${chosen}”. Add the other combinations below.`
            : 'Add the variants worth stocking below.',
      })
      close()
    } catch (caught) {
      setError(
        isApiError(caught) && caught.code === 'DOMAIN_RULE_VIOLATION'
          ? messageOf(caught)
          : messageOf(caught, 'The option could not be added.'),
      )
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={add.isPending ? () => undefined : close}
      dismissible={!add.isPending}
      title="Add an option"
      description="An axis this product varies on — colour, material, size, length, capacity."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={add.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!ready}
            isLoading={add.isPending}
          >
            Add option
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Field
          label="Option name"
          required
          error={duplicate ? 'This product already has an option with that name.' : undefined}
        >
          <Input
            value={name}
            maxLength={60}
            data-autofocus
            placeholder="Colour"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Values" required hint="Type a value and press Enter. Commas work too.">
          <TagsInput
            value={values}
            maxTags={50}
            maxLength={80}
            placeholder="Black, Navy, Sand…"
            onChange={setValues}
          />
        </Field>

        {variantCount > 0 ? (
          <Field
            label={`What the ${variantCount === 1 ? 'existing variant becomes' : `${variantCount} existing variants become`}`}
            hint="Every variant already on this product takes this value. You can change them individually afterwards."
          >
            <Select
              value={chosen}
              disabled={values.length === 0}
              onChange={(event) => setApplies(event.target.value)}
              options={
                values.length > 0
                  ? values.map((value) => ({ value, label: value }))
                  : [{ value: '', label: 'Add a value first' }]
              }
            />
          </Field>
        ) : null}

        <Alert tone="info">
          Adding an option creates no new variants. Once it exists, add the combinations worth
          stocking in the Variants card.
        </Alert>
      </div>
    </Modal>
  )
}
