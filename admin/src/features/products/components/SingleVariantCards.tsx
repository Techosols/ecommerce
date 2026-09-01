import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import type { FormState } from '@/lib/useFormState'
import { VariantInventoryPanel } from './VariantInventoryPanel'
import type { VariantFormValues } from './variantForm'

/**
 * The cards a product with no options shows in place of a variants table.
 *
 * Such a product has exactly one variant — the server's unique constraint on the
 * option signature guarantees it — so its price, identifiers and shipping can be
 * edited as though they belonged to the product, which is how an operator thinks
 * of them anyway. They still travel to `PATCH /admin/variants/:id`, because the
 * product row has no price column and never will.
 *
 * The moment options are added, these disappear and the variants table takes
 * over: with several variants there is no single price to show here.
 */
export interface SingleVariantCardProps {
  form: FormState<VariantFormValues>
  currency: string
  disabled?: boolean
}

export function ProductPricingCard({ form, currency, disabled = false }: SingleVariantCardProps) {
  return (
    <Card>
      <CardHeader title="Pricing" />
      <CardBody className="grid gap-4 sm:grid-cols-2">
        <Field label="Price" error={form.errors.priceAmount} required>
          <MoneyInput
            currency={currency}
            value={form.values.priceAmount}
            disabled={disabled}
            onValueChange={(amount) => form.setValue('priceAmount', amount)}
          />
        </Field>
        <Field
          label="Compare-at price"
          error={form.errors.compareAtAmount}
          hint="Shown struck through. Must be above the price, or blank."
        >
          <MoneyInput
            currency={currency}
            value={form.values.compareAtAmount}
            disabled={disabled}
            onValueChange={(amount) => form.setValue('compareAtAmount', amount)}
          />
        </Field>
      </CardBody>
    </Card>
  )
}

export function ProductIdentifiersCard({ form, disabled = false }: Omit<SingleVariantCardProps, 'currency'>) {
  return (
    <Card>
      {/* Shopify keeps SKU and barcode inside the Inventory card. They are
          split out here because this admin's inventory panel is a ledger view
          with its own writes, and burying two plain text inputs inside it would
          make them look like they save the same way stock does. */}
      <CardHeader title="Identifiers" description="How this product is referred to in a warehouse." />
      <CardBody className="grid gap-4 sm:grid-cols-2">
        <Field label="SKU" error={form.errors.sku} hint="Unique across the store.">
          <Input
            value={form.values.sku}
            maxLength={64}
            disabled={disabled}
            onChange={(event) => form.setValue('sku', event.target.value)}
          />
        </Field>
        <Field label="Barcode" error={form.errors.barcode} hint="ISBN, UPC, GTIN.">
          <Input
            value={form.values.barcode}
            maxLength={64}
            disabled={disabled}
            onChange={(event) => form.setValue('barcode', event.target.value)}
          />
        </Field>
      </CardBody>
    </Card>
  )
}

export function ProductShippingCard({ form, disabled = false }: Omit<SingleVariantCardProps, 'currency'>) {
  return (
    <Card>
      <CardHeader title="Shipping" />
      <CardBody className="flex flex-col gap-4">
        <Checkbox
          checked={form.values.requiresShipping}
          disabled={disabled}
          label="This is a physical product"
          description="Untick for a service or a digital item — it is then never rated for delivery."
          onChange={(event) => form.setValue('requiresShipping', event.target.checked)}
        />
        {form.values.requiresShipping ? (
          <Field label="Weight" error={form.errors.weightGrams} hint="In grams.">
            <Input
              type="number"
              min={0}
              className="w-40"
              value={form.values.weightGrams}
              disabled={disabled}
              onChange={(event) => form.setValue('weightGrams', event.target.value)}
            />
          </Field>
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * Stock for the single variant.
 *
 * Outside the form on purpose: a movement is committed the moment it is made,
 * with a reason attached, and it would be wrong for it to sit unsaved beside a
 * title edit.
 */
export function ProductInventoryCard({
  variantId,
  disabled = false,
}: {
  variantId: string
  disabled?: boolean
}) {
  return (
    <Card>
      <CardHeader title="Inventory" description="Stock is a ledger — it moves, it is not typed over." />
      <CardBody>
        <VariantInventoryPanel variantId={variantId} disabled={disabled} />
      </CardBody>
    </Card>
  )
}
