import { useMemo } from 'react'
import { Archive, ImageOff } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Drawer } from '@/components/ui/Drawer'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { useToast } from '@/components/ui/toast.context'
import { cn } from '@/lib/cn'
import { useFormState } from '@/lib/useFormState'
import { useUpdateVariant } from '../hooks/products.hooks'
import type { ProductMedia, ProductVariant } from '../types/products.types'
import { MetafieldsCard } from '@/features/metafields/components/MetafieldsCard'
import { VariantInventoryPanel } from './VariantInventoryPanel'
import { toVariantFormValues, toVariantPatch, variantLabel, type VariantFormValues } from './variantForm'

export interface VariantDrawerProps {
  variant: ProductVariant
  media: ProductMedia[]
  currency: string
  canEdit: boolean
  onClose: () => void
  onArchive: (variant: ProductVariant) => void
  /** The server refuses to archive a product's last live variant. */
  isOnlyLiveVariant: boolean
}

/**
 * One variant, every field of it.
 *
 * A drawer rather than an inline row: a variant carries ten editable fields, an
 * image and its own stock, and none of that fits in a table cell. The list stays
 * visible behind it so an operator working down a size run keeps their place.
 *
 * Two things deliberately do not share the Save button. Stock moves through the
 * inventory ledger the moment it is adjusted, because a movement is an event
 * with a reason rather than a field; and archiving is a lifecycle decision with
 * its own confirmation. Everything `updateVariantSchema` accepts is the form.
 */
export function VariantDrawer({
  variant,
  media,
  currency,
  canEdit,
  onClose,
  onArchive,
  isOnlyLiveVariant,
}: VariantDrawerProps) {
  const { toast } = useToast()
  const update = useUpdateVariant()

  const form = useFormState<VariantFormValues>(
    // The drawer is mounted fresh per variant (keyed by the caller), so the
    // baseline is this variant and never needs re-syncing mid-edit.
    useMemo(() => toVariantFormValues(variant), [variant.id]), // eslint-disable-line react-hooks/exhaustive-deps
  )

  const label = variantLabel(variant)
  const disabled = !canEdit || variant.isArchived || update.isPending
  const ready = media.filter((entry) => entry.url !== null)

  async function save() {
    if (!form.isDirty || update.isPending) return

    const patch = toVariantPatch(form.dirty)
    if (Object.keys(patch).length === 0) {
      form.reset(form.values)
      return
    }

    try {
      const saved = await update.mutateAsync({ variantId: variant.id, patch })
      form.reset(toVariantFormValues(saved))
      toast({ tone: 'success', title: `${label} saved` })
      onClose()
    } catch (error) {
      form.applyServerError(error, 'The variant could not be saved.')
    }
  }

  return (
    <Drawer
      isOpen
      onClose={onClose}
      dismissible={!update.isPending}
      size="lg"
      title={label}
      description={
        variant.isArchived
          ? 'Archived — restore is not offered, because an order line still resolves through it.'
          : 'Price, identifiers, shipping and stock for this one purchasable unit.'
      }
      footer={
        <>
          {canEdit && !variant.isArchived ? (
            <Button
              variant="ghost"
              leadingIcon={<Archive className="size-4" />}
              className="text-danger hover:bg-danger-soft mr-auto"
              disabled={isOnlyLiveVariant || update.isPending}
              title={isOnlyLiveVariant ? 'A product must keep at least one live variant' : undefined}
              onClick={() => onArchive(variant)}
            >
              Archive variant
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            {canEdit && !variant.isArchived ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && !variant.isArchived ? (
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={!form.isDirty}
              isLoading={update.isPending}
            >
              Save variant
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {form.formError ? <Alert tone="danger">{form.formError}</Alert> : null}

        {variant.options.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {variant.options.map((selection) => (
              <Badge key={selection.optionId} tone="neutral">
                {selection.name}: {selection.value}
              </Badge>
            ))}
          </div>
        ) : null}

        <Field
          label="Variant name"
          error={form.errors.title}
          hint="What this variant is called in the admin and on an order line."
        >
          <Input
            value={form.values.title}
            maxLength={200}
            disabled={disabled}
            onChange={(event) => form.setValue('title', event.target.value)}
          />
        </Field>

        <section>
          <h3 className="text-ink mb-2 text-sm font-semibold">Pricing</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price" error={form.errors.priceAmount} required>
              <MoneyInput
                currency={currency}
                value={form.values.priceAmount}
                disabled={disabled}
                onValueChange={(amount) => form.setValue('priceAmount', amount)}
              />
            </Field>
            <Field
              label="Compare at"
              error={form.errors.compareAtAmount}
              hint="Must be above the price, or blank."
            >
              <MoneyInput
                currency={currency}
                value={form.values.compareAtAmount}
                disabled={disabled}
                onValueChange={(amount) => form.setValue('compareAtAmount', amount)}
              />
            </Field>
          </div>
        </section>

        <section>
          <h3 className="text-ink mb-2 text-sm font-semibold">Identifiers</h3>
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
        </section>

        <section>
          <h3 className="text-ink mb-2 text-sm font-semibold">Shipping</h3>
          <div className="flex flex-col gap-3">
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
          </div>
        </section>

        <section>
          <h3 className="text-ink mb-2 text-sm font-semibold">Availability</h3>
          <Checkbox
            checked={form.values.isActive}
            disabled={disabled}
            label="Available for sale"
            description="An inactive variant stays on the product but cannot be bought."
            onChange={(event) => form.setValue('isActive', event.target.checked)}
          />
        </section>

        <section>
          <h3 className="text-ink mb-2 text-sm font-semibold">Image</h3>
          {ready.length === 0 ? (
            <p className="text-muted flex items-center gap-2 text-sm">
              <ImageOff className="text-faint size-4" />
              Add images to the product first, then pick one for this variant.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              <li>
                <ImageChoice
                  selected={form.values.mediaId === ''}
                  disabled={disabled}
                  label="No specific image"
                  onSelect={() => form.setValue('mediaId', '')}
                >
                  <span className="text-faint flex size-full items-center justify-center text-[0.625rem]">
                    None
                  </span>
                </ImageChoice>
              </li>
              {ready.map((entry) => (
                <li key={entry.id}>
                  <ImageChoice
                    selected={form.values.mediaId === entry.id}
                    disabled={disabled}
                    label={entry.alt ?? 'Product image'}
                    onSelect={() => form.setValue('mediaId', entry.id)}
                  >
                    <img
                      src={entry.variants.thumb ?? entry.variants.medium ?? entry.url ?? ''}
                      alt={entry.alt ?? ''}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  </ImageChoice>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-line border-t pt-5">
          <h3 className="text-ink mb-2 text-sm font-semibold">Inventory</h3>
          <VariantInventoryPanel variantId={variant.id} disabled={variant.isArchived} />
        </section>

        {/* Per-variant custom fields — a shade's hex code, a size's volume.
            Renders nothing at all unless fields are defined for variants, so a
            shop that has none never sees an empty section here. */}
        <MetafieldsCard
          ownerType="variant"
          ownerId={variant.id}
          canWrite={canEdit && !variant.isArchived}
        />
      </div>
    </Drawer>
  )
}

function ImageChoice({
  selected,
  disabled,
  label,
  onSelect,
  children,
}: {
  selected: boolean
  disabled: boolean
  label: string
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={selected ? `${label} (selected)` : label}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'bg-surface-sunken size-16 overflow-hidden rounded-lg border transition-all',
        selected ? 'border-brand-500 ring-brand-500/30 ring-2' : 'border-line hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {children}
    </button>
  )
}
