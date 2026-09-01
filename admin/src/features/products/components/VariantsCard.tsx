import { useState } from 'react'
import { Boxes, ImageOff, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { useAuth } from '@/features/auth/useAuth'
import { messageOf } from '@/lib/api/errors'
import { cn } from '@/lib/cn'
import { formatMoney, formatNumber } from '@/lib/format'
import { useArchiveVariant, useVariantInventory } from '../hooks/products.hooks'
import type { ProductMedia, ProductOption, ProductVariant } from '../types/products.types'
import { AddVariantDialog } from './AddVariantDialog'
import { VariantDrawer } from './VariantDrawer'
import { variantLabel } from './variantForm'

/** Stock for one variant, or nothing at all without `inventory:read`. */
function VariantStock({ variantId }: { variantId: string }) {
  const { data, isPending, isError } = useVariantInventory(variantId)

  if (isPending) return <span className="text-faint text-xs">…</span>
  if (isError || !data) return <span className="text-faint text-xs">—</span>
  if (!data.trackInventory) return <span className="text-muted text-xs">Not tracked</span>

  return (
    <span
      className={
        data.isLow ? 'text-warning tabular text-sm font-semibold' : 'text-ink tabular text-sm'
      }
      title={`${formatNumber(data.totals.onHand)} on hand, ${formatNumber(data.totals.reserved)} reserved`}
    >
      {formatNumber(data.totals.available)}
    </span>
  )
}

export interface VariantsCardProps {
  productId: string
  options: ProductOption[]
  variants: ProductVariant[]
  media: ProductMedia[]
  currency: string
  canEdit: boolean
}

/**
 * Every purchasable unit of the product, and the way into each one.
 *
 * The table is a summary; the editing happens in `VariantDrawer`, because a
 * variant has ten fields and a table row has room for four. A row opens it, the
 * way a Shopify variant row does.
 *
 * Adding is offered only when the product has options: with no axes there is
 * exactly one possible combination — the empty one — and the product already
 * has it. The server enforces that with a unique constraint on the option
 * signature; the button's absence is the same rule, said earlier.
 */
export function VariantsCard({
  productId,
  options,
  variants,
  media,
  currency,
  canEdit,
}: VariantsCardProps) {
  const { toast } = useToast()
  const { can } = useAuth()
  const archive = useArchiveVariant()

  const [editing, setEditing] = useState<ProductVariant | null>(null)
  const [archiving, setArchiving] = useState<ProductVariant | null>(null)
  const [adding, setAdding] = useState(false)

  const canReadInventory = can('inventory:read')
  const live = variants.filter((variant) => !variant.isArchived)
  const sorted = [...variants].sort(
    (a, b) => Number(a.isArchived) - Number(b.isArchived) || a.position - b.position,
  )

  // The row's own thumbnail, or the product's primary image as a fallback —
  // `mediaId` names a product-media row, never a raw asset.
  const primary = media.find((entry) => entry.isPrimary) ?? media[0]
  function thumbOf(variant: ProductVariant) {
    const own = variant.mediaId ? media.find((entry) => entry.id === variant.mediaId) : undefined
    return own ?? primary
  }

  // A drawer opened on a stale copy would show yesterday's price after a
  // refetch, so the open variant is re-read from the live list each render.
  const open = editing ? (variants.find((variant) => variant.id === editing.id) ?? null) : null

  return (
    <Card>
      <CardHeader
        title="Variant list"
        description="A variant is the purchasable unit — it carries the price, the SKU and the stock."
        actions={
          canEdit && options.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setAdding(true)}
            >
              Add variant
            </Button>
          ) : undefined
        }
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
                <th className="text-muted hidden px-4 py-2.5 text-left text-xs font-semibold sm:table-cell">
                  SKU
                </th>
                {canReadInventory ? (
                  <th className="text-muted hidden px-4 py-2.5 text-right text-xs font-semibold lg:table-cell">
                    Available
                  </th>
                ) : null}
                <th className="px-4 py-2.5">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((variant) => {
                const label = variantLabel(variant)
                const thumb = thumbOf(variant)
                return (
                  <tr
                    key={variant.id}
                    onClick={() => setEditing(variant)}
                    className={cn(
                      'border-line hover:bg-surface-hover cursor-pointer border-b last:border-0',
                      variant.isArchived && 'opacity-60',
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="bg-surface-sunken border-line size-9 shrink-0 overflow-hidden rounded border">
                          {thumb?.url ? (
                            <img
                              src={thumb.variants.thumb ?? thumb.variants.medium ?? thumb.url}
                              alt=""
                              loading="lazy"
                              className="size-full object-cover"
                            />
                          ) : (
                            <span className="text-faint flex size-full items-center justify-center">
                              <ImageOff className="size-3.5" />
                            </span>
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
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
                          </span>
                          {variant.options.length > 0 ? (
                            <span className="text-faint block truncate text-xs">
                              {variant.options
                                .map((option) => `${option.name}: ${option.value}`)
                                .join(' · ')}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-right">
                      <span className="text-ink tabular font-medium">
                        {formatMoney(variant.price)}
                      </span>
                      {variant.compareAtPrice ? (
                        <span className="text-faint tabular block text-xs line-through">
                          {formatMoney(variant.compareAtPrice)}
                        </span>
                      ) : null}
                    </td>

                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className="text-muted font-mono text-xs">{variant.sku ?? '—'}</span>
                    </td>

                    {canReadInventory ? (
                      <td className="hidden px-4 py-3 text-right lg:table-cell">
                        <VariantStock variantId={variant.id} />
                      </td>
                    ) : null}

                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          setEditing(variant)
                        }}
                      >
                        {canEdit && !variant.isArchived ? 'Edit' : 'View'}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <VariantDrawer
          key={open.id}
          variant={open}
          media={media}
          currency={currency}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onArchive={setArchiving}
          isOnlyLiveVariant={live.length === 1 && !open.isArchived}
        />
      ) : null}

      {options.length > 0 ? (
        <AddVariantDialog
          productId={productId}
          options={options}
          variants={variants}
          currency={currency}
          isOpen={adding}
          onClose={() => setAdding(false)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={archiving !== null}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Variant archived' })
              setArchiving(null)
              setEditing(null)
            },
            onError: (error) => {
              toast({
                tone: 'error',
                title: 'Could not archive the variant',
                description: messageOf(error),
              })
              setArchiving(null)
            },
          })
        }}
        title={archiving ? `Archive “${variantLabel(archiving)}”?` : 'Archive this variant?'}
        confirmLabel="Archive variant"
        tone="danger"
        isLoading={archive.isPending}
      >
        Customers will no longer be able to buy it. Nothing is deleted — orders that already
        reference this variant keep working, and it keeps its option combination.
      </ConfirmDialog>
    </Card>
  )
}
