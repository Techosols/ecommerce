import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { Skeleton } from '@/components/ui/Skeleton'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import { useAuth } from '@/features/auth/useAuth'
import { StockAdjuster } from './StockAdjuster'
import { useUpdateInventoryItem, useVariantInventory } from '../hooks/products.hooks'

export interface VariantInventoryPanelProps {
  variantId: string
  disabled?: boolean
}

/**
 * Stock for one variant: whether it is tracked, how much there is, and where.
 *
 * Three different permissions meet here, and the panel degrades rather than
 * erroring for each: `inventory:read` to see any of it, `inventory:adjust` to
 * move stock, `inventory:manage` to change the tracking policy. A packer with
 * only `inventory:read` sees the numbers and no controls.
 *
 * The quantity is never edited directly — see `StockAdjuster`.
 */
export function VariantInventoryPanel({ variantId, disabled = false }: VariantInventoryPanelProps) {
  const { can } = useAuth()
  const { toast } = useToast()
  const query = useVariantInventory(variantId)
  const updateItem = useUpdateInventoryItem(variantId)

  const canRead = can('inventory:read')
  const canAdjust = can('inventory:adjust')
  const canManage = can('inventory:manage')

  if (!canRead) {
    return (
      <p className="text-muted text-sm">
        Stock levels need the <code>inventory:read</code> permission.
      </p>
    )
  }

  if (query.isPending) return <Skeleton className="h-24 w-full" />

  if (query.error || !query.data) {
    return <Alert tone="warning">Stock for this variant could not be loaded.</Alert>
  }

  const inventory = query.data

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-ink text-sm font-medium">Track quantity</p>
            <p className="text-muted mt-0.5 text-xs">
              Untracked variants are always purchasable, however much stock says.
            </p>
          </div>
          <Switch
            checked={inventory.trackInventory}
            disabled={disabled || updateItem.isPending}
            label="Track quantity"
            onCheckedChange={(checked) =>
              updateItem.mutate(
                { inventoryItemId: inventory.id, patch: { trackInventory: checked } },
                {
                  onSuccess: () =>
                    toast({
                      tone: 'success',
                      title: checked ? 'Now tracking stock' : 'No longer tracking stock',
                    }),
                  onError: (error) =>
                    toast({
                      tone: 'error',
                      title: 'Could not change tracking',
                      description: messageOf(error),
                    }),
                },
              )
            }
          />
        </div>
      ) : null}

      {inventory.trackInventory ? (
        <>
          <div className="border-line grid grid-cols-3 gap-px overflow-hidden rounded-lg border">
            <Figure label="Available" value={inventory.totals.available} highlight={inventory.isLow} />
            <Figure label="On hand" value={inventory.totals.onHand} />
            <Figure label="Reserved" value={inventory.totals.reserved} />
          </div>

          {inventory.isLow ? (
            <Alert tone="warning">
              At or below the low-stock threshold of{' '}
              {formatNumber(inventory.effectiveLowStockThreshold)}.
            </Alert>
          ) : null}

          {canAdjust ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted text-xs">
                Stock moves by an amount and a reason, so every change is explainable.
              </p>
              <StockAdjuster
                variantId={variantId}
                inventory={inventory}
                disabled={disabled}
              />
            </div>
          ) : null}

          {inventory.levels.length > 1 ? (
            <div>
              <p className="text-muted mb-1.5 text-xs font-semibold tracking-wide uppercase">
                By location
              </p>
              <ul className="divide-line border-line divide-y rounded-lg border text-sm">
                {inventory.levels.map((level) => (
                  <li
                    key={level.locationId}
                    className="flex items-center justify-between px-3 py-2"
                  >
                    <span className="text-ink-soft">{level.locationName}</span>
                    <span className="text-ink tabular font-medium">
                      {formatNumber(level.available)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {canManage ? (
            <Field
              label="Low stock threshold"
              hint="Leave blank to use the store default."
            >
              <Input
                type="number"
                min={0}
                className="w-40"
                defaultValue={inventory.lowStockThreshold ?? ''}
                placeholder={String(inventory.effectiveLowStockThreshold)}
                disabled={disabled || updateItem.isPending}
                onBlur={(event) => {
                  const raw = event.target.value.trim()
                  const next = raw === '' ? null : Number(raw)
                  if (next !== null && (!Number.isInteger(next) || next < 0)) return
                  if (next === inventory.lowStockThreshold) return
                  updateItem.mutate(
                    { inventoryItemId: inventory.id, patch: { lowStockThreshold: next } },
                    {
                      onSuccess: () => toast({ tone: 'success', title: 'Threshold updated' }),
                      onError: (error) =>
                        toast({
                          tone: 'error',
                          title: 'Could not update the threshold',
                          description: messageOf(error),
                        }),
                    },
                  )
                }}
              />
            </Field>
          ) : null}
        </>
      ) : (
        <Badge tone="neutral">Stock is not tracked for this variant</Badge>
      )}
    </div>
  )
}

function Figure({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className="bg-surface px-3 py-2.5 text-center">
      <p className="text-muted text-[0.6875rem] font-medium tracking-wide uppercase">{label}</p>
      <p
        className={
          highlight
            ? 'text-warning tabular mt-0.5 text-lg font-semibold'
            : 'text-ink tabular mt-0.5 text-lg font-semibold'
        }
      >
        {formatNumber(value)}
      </p>
    </div>
  )
}
