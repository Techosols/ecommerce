import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useAddVariant } from '../hooks/products.hooks'
import type { ProductOption, ProductVariant } from '../types/products.types'

export interface AddVariantDialogProps {
  productId: string
  options: ProductOption[]
  variants: ProductVariant[]
  currency: string
  isOpen: boolean
  onClose: () => void
}

/** `{ Size: 'Large' }` → a key that ignores the order the axes were read in. */
function signature(selection: Record<string, string>): string {
  return Object.keys(selection)
    .sort()
    .map((name) => `${name}=${selection[name]!}`)
    .join('|')
}

/** The combination a variant already occupies, in the same shape. */
function signatureOfVariant(variant: ProductVariant): string {
  return signature(
    Object.fromEntries(variant.options.map((option) => [option.name, option.value])),
  )
}

/**
 * Adding one combination to a product that already has options.
 *
 * The dialog offers a value per axis because the server demands exactly that: a
 * variant selects one value for **every** option, and a partial selection is a
 * 422 rather than a variant with a gap. Combinations already taken are refused
 * here with a sentence instead of being sent to collide with
 * `variant_combination_is_unique` — including combinations held by an *archived*
 * variant, which still owns its signature.
 */
export function AddVariantDialog({
  productId,
  options,
  variants,
  currency,
  isOpen,
  onClose,
}: AddVariantDialogProps) {
  const { toast } = useToast()
  const add = useAddVariant(productId)

  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(options.map((option) => [option.name, option.values[0]?.value ?? ''])),
  )
  const [priceAmount, setPriceAmount] = useState<number | null>(null)
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const taken = new Set(variants.map(signatureOfVariant))
  const isTaken = taken.has(signature(selection))
  const complete = options.every((option) => (selection[option.name] ?? '') !== '')

  function close() {
    setPriceAmount(null)
    setSku('')
    setBarcode('')
    setError(null)
    onClose()
  }

  async function submit() {
    if (add.isPending) return
    if (!complete) {
      setError('Choose a value for every option.')
      return
    }
    if (isTaken) {
      setError('A variant already covers that combination.')
      return
    }
    if (priceAmount === null) {
      setError('Give the variant a price.')
      return
    }

    try {
      await add.mutateAsync({
        priceAmount,
        options: selection,
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
      })
      toast({
        tone: 'success',
        title: 'Variant added',
        description: 'It starts with no stock — adjust it when the goods arrive.',
      })
      close()
    } catch (caught) {
      setError(messageOf(caught, 'The variant could not be added.'))
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={add.isPending ? () => undefined : close}
      dismissible={!add.isPending}
      title="Add a variant"
      description="A variant chooses one value on every option, and carries its own price."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={add.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={isTaken || !complete}
            isLoading={add.isPending}
          >
            Add variant
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {options.map((option) => (
            <Field key={option.id} label={option.name}>
              <Select
                value={selection[option.name] ?? ''}
                onChange={(event) => {
                  setError(null)
                  setSelection((current) => ({ ...current, [option.name]: event.target.value }))
                }}
                options={option.values.map((value) => ({
                  value: value.value,
                  label: value.value,
                }))}
              />
            </Field>
          ))}
        </div>

        {isTaken ? (
          <Alert tone="warning">
            A variant already covers that combination — an archived one counts, because it keeps its
            place forever.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price" required>
            <MoneyInput
              currency={currency}
              value={priceAmount}
              data-autofocus
              onValueChange={(amount) => {
                setError(null)
                setPriceAmount(amount)
              }}
            />
          </Field>
          <Field label="SKU" hint="Optional, unique across the store.">
            <Input value={sku} maxLength={64} onChange={(event) => setSku(event.target.value)} />
          </Field>
          <Field label="Barcode" hint="Optional." className="sm:col-span-2">
            <Input
              value={barcode}
              maxLength={64}
              onChange={(event) => setBarcode(event.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
