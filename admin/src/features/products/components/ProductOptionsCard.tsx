import { useState, type KeyboardEvent } from 'react'
import { Plus, SlidersHorizontal, X } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { SwatchPicker } from '@/components/ui/SwatchPicker'
import { useToast } from '@/components/ui/toast.context'
import { isApiError, messageOf } from '@/lib/api/errors'
import { cn } from '@/lib/cn'
import { AddOptionDialog } from './AddOptionDialog'
import {
  useAddOptionValue,
  useRemoveOptionValue,
  useSetOptionValueSwatch,
} from '../hooks/products.hooks'
import type { ProductOption, ProductOptionValue, ProductVariant } from '../types/products.types'

/** The server allows at most three axes per product. */
const MAX_OPTIONS = 3

/**
 * The names merchants actually give a colour axis, in the languages this shop
 * is likely to be run in. Matched loosely so "Shade", "Colour family" and
 * "Farbe" all count.
 */
const COLOUR_WORDS = /colou?r|shade|tone|finish|farbe|couleur|رنگ/i

/**
 * Whether to offer a colour picker on this option at all.
 *
 * Two ways to qualify. The name is the usual one — a merchant naming an axis
 * "Shade" has told us what it is. The second matters more: once *any* value on
 * an option carries a colour, the picker stays available on all of them
 * regardless of the name, so a merchant who called their axis "Fabric" and set
 * one swatch by hand is never locked out of setting the rest.
 */
function isColourOption(option: ProductOption): boolean {
  return (
    COLOUR_WORDS.test(option.name) || option.values.some((value) => value.swatchHex !== null)
  )
}

export interface ProductOptionsCardProps {
  productId: string
  options: ProductOption[]
  variants: ProductVariant[]
  canEdit: boolean
}

/**
 * The axes a product varies on.
 *
 * Everything here is additive, which is what makes it safe on a product that is
 * already selling. A new **value** is selected by nothing yet, so every variant
 * still chooses one value per option. A new **axis** is written onto every
 * existing variant at the value the merchant picks, so none of them is left
 * with a gap — the dialog asks for that value because there is no sensible
 * default the server could invent.
 *
 * Removal is the one thing the server refuses freely: a value any variant still
 * records — archived ones included — stays, because an order line resolves
 * through that variant and it would stop being able to describe itself.
 */
export function ProductOptionsCard({
  productId,
  options,
  variants,
  canEdit,
}: ProductOptionsCardProps) {
  const { toast } = useToast()
  const addValue = useAddOptionValue(productId)
  const removeValue = useRemoveOptionValue(productId)
  const setSwatch = useSetOptionValueSwatch(productId)

  const [draft, setDraft] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<{
    option: ProductOption
    value: ProductOptionValue
  } | null>(null)

  const liveVariants = variants.filter((variant) => !variant.isArchived)
  const busy = addValue.isPending || removeValue.isPending || setSwatch.isPending
  const atLimit = options.length >= MAX_OPTIONS

  /** How many live variants use a value — what the chip shows before you remove it. */
  function usageOf(valueId: string): number {
    return liveVariants.filter((variant) =>
      variant.options.some((selection) => selection.valueId === valueId),
    ).length
  }

  function commit(option: ProductOption) {
    const value = (draft[option.id] ?? '').trim()
    if (!value || busy) return

    addValue.mutate(
      { optionId: option.id, value },
      {
        onSuccess: () => {
          setDraft((current) => ({ ...current, [option.id]: '' }))
          toast({
            tone: 'success',
            title: `“${value}” added to ${option.name}`,
            description: 'Add a variant to put it on sale.',
          })
        },
        onError: (error) =>
          toast({
            tone: isApiError(error) && error.code === 'ALREADY_EXISTS' ? 'warning' : 'error',
            title: 'Could not add that value',
            description: messageOf(error),
          }),
      },
    )
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, option: ProductOption) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit(option)
    }
  }

  const addButton =
    canEdit && !atLimit ? (
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<Plus className="size-4" />}
        onClick={() => setAdding(true)}
      >
        {options.length === 0 ? 'Add options' : 'Add another option'}
      </Button>
    ) : undefined

  const dialog = (
    <AddOptionDialog
      productId={productId}
      options={options}
      variantCount={liveVariants.length}
      isOpen={adding}
      onClose={() => setAdding(false)}
    />
  )

  if (options.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Variants"
          description="The axes this product varies on — size, colour, material, capacity."
          actions={addButton}
        />
        <CardBody>
          <div className="text-muted flex items-start gap-3 text-sm">
            <SlidersHorizontal aria-hidden="true" className="text-faint mt-0.5 size-4 shrink-0" />
            <p>
              This product has one price and one SKU, set above. Add options like size or colour
              to sell it in several versions — each combination becomes a variant with its own
              price, SKU and stock.
            </p>
          </div>
        </CardBody>
        {dialog}
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title="Variants"
        description={`${options.length === 1 ? 'One option' : `${options.length} options`}. Add a value here, then add the variants that use it.`}
        actions={addButton}
      />
      <CardBody className="flex flex-col gap-5">
        {options.map((option) => {
          const colourish = isColourOption(option)
          return (
          <div key={option.id}>
            <p className="text-ink text-sm font-medium">{option.name}</p>

            <ul className="mt-2 flex flex-wrap gap-1.5">
              {option.values.map((value) => {
                const uses = usageOf(value.id)
                return (
                  <li key={value.id}>
                    <span
                      className={cn(
                        'border-line-strong bg-surface-sunken inline-flex items-center gap-1.5 rounded-md border py-1 pr-1 pl-2.5 text-sm',
                        uses === 0 && 'border-dashed',
                      )}
                    >
                      {/* Only where a colour makes sense. Offering a picker on
                          every "Large" and "500 ml" would be noise, so the card
                          shows one once the option looks like a colour axis —
                          by name, or because a value on it already has one. */}
                      {colourish ? (
                        <SwatchPicker
                          hex={value.swatchHex}
                          label={value.value}
                          disabled={!canEdit || busy}
                          onChange={(swatchHex) =>
                            setSwatch.mutate(
                              { optionId: option.id, valueId: value.id, swatchHex },
                              {
                                onError: (error) =>
                                  toast({
                                    tone: 'error',
                                    title: 'That colour did not save',
                                    description: messageOf(error),
                                  }),
                              },
                            )
                          }
                        />
                      ) : null}
                      <span className="text-ink">{value.value}</span>
                      <span
                        className="text-faint tabular text-[0.6875rem]"
                        title={`${uses} variant(s) use this value`}
                      >
                        {uses}
                      </span>
                      {canEdit ? (
                        <button
                          type="button"
                          aria-label={`Remove ${value.value} from ${option.name}`}
                          disabled={busy}
                          onClick={() => setRemoving({ option, value })}
                          className="text-faint hover:text-danger rounded p-0.5 transition-colors disabled:pointer-events-none"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>

            {canEdit ? (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  size="sm"
                  className="w-48"
                  maxLength={80}
                  aria-label={`Add a value to ${option.name}`}
                  placeholder={`Add a ${option.name.toLowerCase()}…`}
                  value={draft[option.id] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [option.id]: event.target.value }))
                  }
                  onKeyDown={(event) => onKeyDown(event, option)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Plus className="size-3.5" />}
                  disabled={busy || !(draft[option.id] ?? '').trim()}
                  onClick={() => commit(option)}
                >
                  Add
                </Button>
              </div>
            ) : null}
          </div>
          )
        })}

        {canEdit && atLimit ? (
          <p className="text-muted text-xs">
            A product may vary on at most {MAX_OPTIONS} axes — every one multiplies the number of
            variants somebody has to price and count.
          </p>
        ) : null}

        <Alert tone="info">
          Adding a value does not create variants. Add the combinations worth stocking in the
          Variants card below.
        </Alert>
      </CardBody>

      {dialog}

      <ConfirmDialog
        isOpen={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return
          removeValue.mutate(
            { optionId: removing.option.id, valueId: removing.value.id },
            {
              onSuccess: () => {
                toast({ tone: 'success', title: `“${removing.value.value}” removed` })
                setRemoving(null)
              },
              onError: (error) => {
                const inUse = isApiError(error) && error.code === 'OPTION_VALUE_IN_USE'
                toast({
                  tone: inUse ? 'warning' : 'error',
                  title: inUse ? 'That value is still in use' : 'Could not remove the value',
                  description: messageOf(error),
                })
                setRemoving(null)
              },
            },
          )
        }}
        title={`Remove “${removing?.value.value ?? ''}”?`}
        confirmLabel="Remove value"
        tone="danger"
        isLoading={removeValue.isPending}
      >
        {removing && usageOf(removing.value.id) > 0
          ? `${usageOf(removing.value.id)} variant(s) still use this value. The server will refuse until they are archived.`
          : 'Nothing currently uses this value, so removing it changes no variant.'}
      </ConfirmDialog>
    </Card>
  )
}
