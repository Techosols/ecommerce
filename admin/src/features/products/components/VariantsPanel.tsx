import { useState } from 'react'
import { Boxes, Check, Pencil, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { messageOf } from '@/lib/api/errors'
import { formatMoney, formatNumber } from '@/lib/format'
import { useAuth } from '@/features/auth/useAuth'
import { useArchiveVariant, useUpdateVariant, useVariantInventory } from '../hooks/products.hooks'
import type { ProductVariant, UpdateVariantInput } from '../types/products.types'

/** Stock for one variant, or nothing at all without `inventory:read`. */
function VariantStock({ variantId }: { variantId: string }) {
  const { data, isPending, isError } = useVariantInventory(variantId)

  if (isPending) return <span className="text-faint text-xs">…</span>
  if (isError || !data) return <span className="text-faint text-xs">—</span>
  if (!data.trackInventory) return <span className="text-muted text-xs">Not tracked</span>

  return (
    <span
      className={cnStock(data.isLow)}
      title={`${formatNumber(data.totals.onHand)} on hand, ${formatNumber(data.totals.reserved)} reserved`}
    >
      {formatNumber(data.totals.available)}
    </span>
  )
}

function cnStock(isLow: boolean): string {
  return isLow ? 'text-warning tabular text-sm font-semibold' : 'text-ink tabular text-sm'
}

interface VariantRowProps {
  variant: ProductVariant
  currency: string
  canEdit: boolean
  canReadInventory: boolean
  onArchive: (variant: ProductVariant) => void
  isOnlyLiveVariant: boolean
}

function VariantRow({
  variant,
  currency,
  canEdit,
  canReadInventory,
  onArchive,
  isOnlyLiveVariant,
}: VariantRowProps) {
  const { toast } = useToast()
  const update = useUpdateVariant()
  const [editing, setEditing] = useState(false)
  const [price, setPrice] = useState<number | null>(variant.price?.amount ?? null)
  const [compareAt, setCompareAt] = useState<number | null>(variant.compareAtPrice?.amount ?? null)
  const [sku, setSku] = useState(variant.sku ?? '')

  function cancel() {
    setPrice(variant.price?.amount ?? null)
    setCompareAt(variant.compareAtPrice?.amount ?? null)
    setSku(variant.sku ?? '')
    setEditing(false)
  }

  function save() {
    // Only what changed. A PATCH carrying every field would resend values
    // nobody touched, overwriting a colleague's concurrent edit.
    const patch: UpdateVariantInput = {}
    if (price !== null && price !== variant.price?.amount) patch.priceAmount = price
    if (compareAt !== (variant.compareAtPrice?.amount ?? null)) patch.compareAtAmount = compareAt
    if (sku.trim() !== (variant.sku ?? '')) patch.sku = sku.trim() === '' ? null : sku.trim()

    if (Object.keys(patch).length === 0) {
      setEditing(false)
      return
    }

    update.mutate(
      { variantId: variant.id, patch },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Variant updated' })
          setEditing(false)
        },
        onError: (error) =>
          toast({
            tone: 'error',
            title: 'Could not save the variant',
            description: messageOf(error),
          }),
      },
    )
  }

  const label =
    variant.options.length > 0
      ? variant.options.map((option) => option.value).join(' / ')
      : variant.title

  return (
    <tr className="border-line border-b last:border-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-ink font-medium">{label}</span>
          {variant.isArchived ? (
            <Badge tone="warning" size="sm">
              Archived
            </Badge>
          ) : !variant.isActive ? (
            <Badge tone="neutral" size="sm">
              Inactive
            </Badge>
          ) : null}
        </div>
        {variant.options.length > 0 ? (
          <span className="text-faint text-xs">
            {variant.options.map((option) => `${option.name}: ${option.value}`).join(' · ')}
          </span>
        ) : null}
      </td>

      <td className="px-4 py-3 text-right">
        {editing ? (
          <MoneyInput
            size="sm"
            currency={currency}
            value={price}
            aria-label={`Price for ${label}`}
            onValueChange={setPrice}
            className="w-32"
          />
        ) : (
          <span className="text-ink tabular font-medium">{formatMoney(variant.price)}</span>
        )}
      </td>

      <td className="hidden px-4 py-3 text-right md:table-cell">
        {editing ? (
          <MoneyInput
            size="sm"
            currency={currency}
            value={compareAt}
            aria-label={`Compare-at price for ${label}`}
            onValueChange={setCompareAt}
            className="w-32"
          />
        ) : (
          <span className="text-muted tabular">{formatMoney(variant.compareAtPrice)}</span>
        )}
      </td>

      <td className="hidden px-4 py-3 sm:table-cell">
        {editing ? (
          <Input
            size="sm"
            value={sku}
            maxLength={64}
            aria-label={`SKU for ${label}`}
            onChange={(event) => setSku(event.target.value)}
            className="w-32"
          />
        ) : (
          <span className="text-muted font-mono text-xs">{variant.sku ?? '—'}</span>
        )}
      </td>

      {canReadInventory ? (
        <td className="hidden px-4 py-3 text-right lg:table-cell">
          <VariantStock variantId={variant.id} />
        </td>
      ) : null}

      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {canEdit && !variant.isArchived ? (
            editing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Cancel editing"
                  disabled={update.isPending}
                  onClick={cancel}
                >
                  <X className="size-4" />
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  iconOnly
                  aria-label={`Save ${label}`}
                  isLoading={update.isPending}
                  onClick={save}
                >
                  <Check className="size-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Edit ${label}`}
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Archive ${label}`}
                  // The server refuses to archive a product's last live variant;
                  // disabling here explains why before the request is made.
                  disabled={isOnlyLiveVariant}
                  title={
                    isOnlyLiveVariant ? 'A product must keep at least one live variant' : undefined
                  }
                  onClick={() => onArchive(variant)}
                  className="hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )
          ) : null}
        </div>
      </td>
    </tr>
  )
}

export interface VariantsPanelProps {
  variants: ProductVariant[]
  currency: string
  canEdit: boolean
}

/**
 * The variants, priced in place.
 *
 * Editing happens per row rather than in a modal because a price change is a
 * single field and an operator adjusting several should not open and close a
 * dialog five times. Each save is its own request against
 * `PATCH /admin/variants/:id`, carrying only the fields that changed.
 */
export function VariantsPanel({ variants, currency, canEdit }: VariantsPanelProps) {
  const { toast } = useToast()
  const { can } = useAuth()
  const archive = useArchiveVariant()
  const [archiving, setArchiving] = useState<ProductVariant | null>(null)

  const canReadInventory = can('inventory:read')
  const live = variants.filter((variant) => !variant.isArchived)
  const sorted = [...variants].sort(
    (a, b) => Number(a.isArchived) - Number(b.isArchived) || a.position - b.position,
  )

  return (
    <Card>
      <CardHeader
        title="Variants"
        description="A variant is the purchasable unit — it carries the price, the SKU and the stock."
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon={<Boxes className="size-5" />}
          title="No variants"
          description="Every product needs at least one variant to be purchasable."
        />
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-line bg-surface-sunken border-b">
                <th className="text-muted px-4 py-2.5 text-left text-xs font-semibold">Variant</th>
                <th className="text-muted px-4 py-2.5 text-right text-xs font-semibold">Price</th>
                <th className="text-muted hidden px-4 py-2.5 text-right text-xs font-semibold md:table-cell">
                  Compare at
                </th>
                <th className="text-muted hidden px-4 py-2.5 text-left text-xs font-semibold sm:table-cell">
                  SKU
                </th>
                {canReadInventory ? (
                  <th className="text-muted hidden px-4 py-2.5 text-right text-xs font-semibold lg:table-cell">
                    Available
                  </th>
                ) : null}
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((variant) => (
                <VariantRow
                  key={variant.id}
                  variant={variant}
                  currency={currency}
                  canEdit={canEdit}
                  canReadInventory={canReadInventory}
                  isOnlyLiveVariant={live.length === 1 && !variant.isArchived}
                  onArchive={setArchiving}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={archiving !== null}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Variant archived' })
              setArchiving(null)
            },
            onError: (error) =>
              toast({
                tone: 'error',
                title: 'Could not archive the variant',
                description: messageOf(error),
              }),
          })
        }}
        title="Archive this variant?"
        confirmLabel="Archive variant"
        tone="danger"
        isLoading={archive.isPending}
      >
        Customers will no longer be able to buy it. Nothing is deleted — orders that already
        reference this variant keep working.
      </ConfirmDialog>
    </Card>
  )
}
