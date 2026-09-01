import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { TagsInput } from '@/components/ui/TagsInput'
import {
  MAX_OPTIONS,
  MAX_VARIANTS,
  combinationsOf,
  emptyVariantDraft,
  signatureOf,
  type OptionDraft,
  type VariantDraft,
} from './variantDrafts'

export interface VariantBuilderProps {
  currency: string
  hasOptions: boolean
  onHasOptionsChange: (value: boolean) => void
  options: OptionDraft[]
  onOptionsChange: (options: OptionDraft[]) => void
  /** Keyed by the option signature, so edits survive a values change. */
  variants: Record<string, VariantDraft>
  onVariantsChange: (variants: Record<string, VariantDraft>) => void
  single: VariantDraft
  onSingleChange: (variant: VariantDraft) => void
  disabled?: boolean
  error?: string | undefined
}

/**
 * Pricing, and the axes a product varies on.
 *
 * The server's model drives the shape of this: a variant is the purchasable
 * unit and carries the price, options are at most three axes, and a variant
 * names its options by *name and value* rather than by id. So the operator
 * declares the axes, and every combination becomes a row that needs a price.
 *
 * Rows are keyed by their option signature rather than by index, which is what
 * lets someone add "XL" to a size list without shifting every price they have
 * already typed onto the wrong variant.
 */
export function VariantBuilder({
  currency,
  hasOptions,
  onHasOptionsChange,
  options,
  onOptionsChange,
  variants,
  onVariantsChange,
  single,
  onSingleChange,
  disabled = false,
  error,
}: VariantBuilderProps) {
  const combinations = useMemo(
    () => (hasOptions ? combinationsOf(options) : []),
    [hasOptions, options],
  )
  const tooMany = combinations.length > MAX_VARIANTS

  function updateOption(index: number, patch: Partial<OptionDraft>) {
    onOptionsChange(options.map((option, i) => (i === index ? { ...option, ...patch } : option)))
  }

  function rowFor(selection: Record<string, string>): VariantDraft {
    return variants[signatureOf(selection)] ?? { ...emptyVariantDraft(), options: selection }
  }

  function updateRow(selection: Record<string, string>, patch: Partial<VariantDraft>) {
    const key = signatureOf(selection)
    onVariantsChange({ ...variants, [key]: { ...rowFor(selection), ...patch, options: selection } })
  }

  return (
    <Card>
      <CardHeader
        title="Pricing and variants"
        description="A variant is what a customer actually buys, and what carries the price."
      />
      <CardBody className="flex flex-col gap-5">
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Checkbox
          checked={hasOptions}
          disabled={disabled}
          onChange={(event) => onHasOptionsChange(event.target.checked)}
          label="This product comes in several variations"
          description="Size, colour, material — up to three axes. Leave unticked for a single price."
        />

        {!hasOptions ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price" required>
              <MoneyInput
                currency={currency}
                value={single.priceAmount}
                disabled={disabled}
                onValueChange={(value) => onSingleChange({ ...single, priceAmount: value })}
              />
            </Field>
            <Field label="Compare at" hint="Shown struck through. Must be above the price.">
              <MoneyInput
                currency={currency}
                value={single.compareAtAmount}
                disabled={disabled}
                onValueChange={(value) => onSingleChange({ ...single, compareAtAmount: value })}
              />
            </Field>
            <Field label="SKU">
              <Input
                value={single.sku}
                maxLength={64}
                disabled={disabled}
                onChange={(event) => onSingleChange({ ...single, sku: event.target.value })}
              />
            </Field>
            <Field label="Barcode">
              <Input
                value={single.barcode}
                maxLength={64}
                disabled={disabled}
                onChange={(event) => onSingleChange({ ...single, barcode: event.target.value })}
              />
            </Field>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {options.map((option, index) => (
                <div key={index} className="border-line bg-surface-sunken rounded-lg border p-3">
                  <div className="flex items-start gap-3">
                    <Field label="Option name" className="w-40 shrink-0">
                      <Input
                        size="sm"
                        value={option.name}
                        maxLength={60}
                        disabled={disabled}
                        placeholder="Size"
                        onChange={(event) => updateOption(index, { name: event.target.value })}
                      />
                    </Field>
                    <Field label="Values" className="min-w-0 flex-1">
                      <TagsInput
                        value={option.values}
                        maxTags={50}
                        maxLength={80}
                        disabled={disabled}
                        placeholder="Add a value and press Enter…"
                        onChange={(values) => updateOption(index, { values })}
                      />
                    </Field>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove option ${option.name || index + 1}`}
                      disabled={disabled}
                      className="mt-6"
                      onClick={() => onOptionsChange(options.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}

              {options.length < MAX_OPTIONS ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  leadingIcon={<Plus className="size-4" />}
                  className="self-start"
                  onClick={() => onOptionsChange([...options, { name: '', values: [] }])}
                >
                  Add an option
                </Button>
              ) : (
                <p className="text-muted text-xs">Three options is the maximum.</p>
              )}
            </div>

            {tooMany ? (
              <Alert tone="danger" title="Too many combinations">
                {combinations.length} variants would be created, and the limit is {MAX_VARIANTS}.
                Reduce the number of values before saving.
              </Alert>
            ) : null}

            {combinations.length > 0 && !tooMany ? (
              <div className="border-line overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-line bg-surface-sunken border-b">
                      <th className="text-muted px-3 py-2 text-left text-xs font-semibold">
                        Variant
                      </th>
                      <th className="text-muted px-3 py-2 text-left text-xs font-semibold">
                        Price
                      </th>
                      <th className="text-muted px-3 py-2 text-left text-xs font-semibold">SKU</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combinations.map((selection) => {
                      const key = signatureOf(selection)
                      const row = rowFor(selection)
                      return (
                        <tr key={key} className="border-line border-b last:border-0">
                          <td className="text-ink px-3 py-2 font-medium">
                            {Object.values(selection).join(' / ')}
                          </td>
                          <td className="px-3 py-2">
                            <MoneyInput
                              size="sm"
                              currency={currency}
                              value={row.priceAmount}
                              disabled={disabled}
                              aria-label={`Price for ${Object.values(selection).join(' / ')}`}
                              onValueChange={(value) =>
                                updateRow(selection, { priceAmount: value })
                              }
                            />
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              size="sm"
                              value={row.sku}
                              maxLength={64}
                              disabled={disabled}
                              aria-label={`SKU for ${Object.values(selection).join(' / ')}`}
                              onChange={(event) =>
                                updateRow(selection, { sku: event.target.value })
                              }
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {combinations.length === 0 ? (
              <p className="text-muted text-sm">
                Name an option and give it at least one value to see the variants it produces.
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  )
}
