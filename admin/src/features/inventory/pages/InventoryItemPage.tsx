import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowLeftRight, ClipboardCheck, Plus } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatCard } from '@/components/ui/StatCard'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatNumber } from '@/lib/format'
import { StockLedger } from '../components/StockLedger'
import { StockMoveDialog, type StockMoveKind } from '../components/StockMoveDialog'
import { ownerLabel } from '../components/inventoryLabels'
import {
  useInventoryItem,
  useLocations,
  useReservations,
  useUpdateItemPolicy,
} from '../hooks/inventory.hooks'
import type { InventoryItemDetail } from '../types/inventory.types'

/**
 * One item's stock, everywhere it is held.
 *
 * Read down: what you can sell, where it physically is, what is holding the
 * part you cannot sell, and then the ledger explaining how it got that way.
 *
 * Nothing on this page sets a quantity. Every control opens a dialog that sends
 * a movement with a reason, because a stock figure somebody typed over is a
 * figure nobody can later explain.
 */
export function InventoryItemPage() {
  const { id } = useParams<{ id: string }>()
  const { can } = useAuth()

  const query = useInventoryItem(id)
  const item = query.data

  useDocumentTitle(item ? `Stock · ${item.productTitle}` : 'Stock')

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="/inventory"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Inventory
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {item ? (
          <ItemView
            item={item}
            canAdjust={can('inventory:adjust')}
            canManage={can('inventory:manage')}
          />
        ) : null}
      </QueryBoundary>
    </div>
  )
}

function ItemView({
  item,
  canAdjust,
  canManage,
}: {
  item: InventoryItemDetail
  canAdjust: boolean
  canManage: boolean
}) {
  const { toast } = useToast()
  const locations = useLocations()
  const reservations = useReservations(item.id)
  const policy = useUpdateItemPolicy(item.id)

  const [moving, setMoving] = useState<StockMoveKind | null>(null)
  const [threshold, setThreshold] = useState(
    item.lowStockThreshold === null ? '' : String(item.lowStockThreshold),
  )

  const [baseline, setBaseline] = useState(item.lowStockThreshold)
  if (baseline !== item.lowStockThreshold) {
    setBaseline(item.lowStockThreshold)
    setThreshold(item.lowStockThreshold === null ? '' : String(item.lowStockThreshold))
  }

  const thresholdDirty =
    threshold !== (item.lowStockThreshold === null ? '' : String(item.lowStockThreshold))

  function savePolicy(patch: { trackInventory?: boolean; lowStockThreshold?: number | null }) {
    policy.mutate(patch, {
      onSuccess: () => toast({ tone: 'success', title: 'Stock settings updated' }),
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
    })
  }

  const locationName = (id: string) =>
    (locations.data ?? []).find((entry) => entry.id === id)?.name ?? 'Unknown location'

  return (
    <>
      <PageHeader
        title={item.productTitle}
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            <span>
              {item.variantTitle}
              {item.sku ? ` · ${item.sku}` : ''}
            </span>
            <Link to={`/products/${item.productId}`} className="text-brand-600 hover:underline">
              Open the product
            </Link>
          </span>
        }
        actions={
          canAdjust && item.trackInventory ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                leadingIcon={<Plus className="size-4" />}
                onClick={() => setMoving('adjust')}
              >
                Adjust
              </Button>
              <Button
                variant="secondary"
                leadingIcon={<ClipboardCheck className="size-4" />}
                onClick={() => setMoving('count')}
              >
                Count
              </Button>
              <Button
                variant="secondary"
                leadingIcon={<ArrowLeftRight className="size-4" />}
                onClick={() => setMoving('transfer')}
              >
                Transfer
              </Button>
            </div>
          ) : undefined
        }
      />

      {!item.trackInventory ? (
        <Alert tone="info" title="Stock is not counted for this item">
          It is always available to buy, however many are on the shelf — a made-to-order item.
          Switch counting on below to start tracking quantities.
        </Alert>
      ) : null}

      {item.trackInventory ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="On hand" value={formatNumber(item.totals.onHand)} hint="On the shelf" />
          <StatCard
            label="Reserved"
            value={formatNumber(item.totals.reserved)}
            hint="Spoken for by baskets and orders"
          />
          <StatCard
            label="Available to sell"
            value={formatNumber(item.totals.available)}
            hint={
              item.isLow
                ? `At or below ${formatNumber(item.effectiveLowStockThreshold)}`
                : undefined
            }
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {item.trackInventory ? (
            <Card>
              <CardHeader title="Where it is" description="Quantities at each location." />
              <CardBody>
                {item.levels.length === 0 ? (
                  <p className="text-muted text-sm">
                    Not stocked anywhere yet. Receive a delivery to put some on a shelf.
                  </p>
                ) : (
                  <ul className="divide-line divide-y">
                    {item.levels.map((level) => (
                      <li key={level.locationId} className="flex items-center gap-3 py-2.5">
                        <span className="min-w-0 flex-1">
                          <span className="text-ink block truncate text-sm font-medium">
                            {level.locationName}
                          </span>
                          <span className="text-faint block text-xs">
                            Updated {formatDateTime(level.updatedAt)}
                          </span>
                        </span>

                        <span className="text-muted tabular shrink-0 text-xs">
                          {formatNumber(level.onHand)} on hand
                          {level.reserved > 0 ? ` · ${formatNumber(level.reserved)} reserved` : ''}
                        </span>

                        <span
                          className={`tabular shrink-0 text-sm font-medium ${
                            level.available <= 0 ? 'text-danger' : 'text-ink'
                          }`}
                        >
                          {formatNumber(level.available)}
                          {/* Labelled: an unlabelled figure next to "6 on hand ·
                              5 reserved" is a third number nobody can name. */}
                          <span className="text-faint ml-1 text-xs font-normal">available</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ) : null}

          <StockLedger itemId={item.id} />
        </div>

        <div className="flex flex-col gap-4">
          {item.trackInventory && item.totals.reserved > 0 ? (
            <Card>
              <CardHeader
                title="Holding stock"
                description="Why some of it cannot be sold right now."
              />
              <CardBody>
                <QueryBoundary
                  isLoading={reservations.isPending}
                  error={reservations.error}
                  onRetry={() => void reservations.refetch()}
                >
                  {reservations.data && reservations.data.length > 0 ? (
                    <ul className="divide-line divide-y">
                      {reservations.data.map((reservation) => (
                        <li key={reservation.id} className="flex items-center gap-2 py-2">
                          <span className="min-w-0 flex-1">
                            {reservation.owner.type === 'order' && reservation.orderNumber ? (
                              <Link
                                to={`/orders/${reservation.owner.id}`}
                                className="text-ink hover:text-brand-600 block truncate text-sm"
                              >
                                {reservation.orderNumber}
                              </Link>
                            ) : (
                              <span className="text-ink block truncate text-sm">
                                {ownerLabel(reservation.owner, reservation.orderNumber)}
                              </span>
                            )}
                            <span className="text-faint block text-xs">
                              {locationName(reservation.locationId)}
                            </span>
                          </span>
                          <Badge size="sm" tone="neutral">
                            {formatNumber(reservation.quantity)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted text-sm">Nothing is holding stock right now.</p>
                  )}
                </QueryBoundary>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Settings" description="How this item is counted." />
            <CardBody className="flex flex-col gap-4">
              <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-ink text-sm font-medium">Count stock</p>
                  <p className="text-muted mt-0.5 text-xs">
                    Off means always available, whatever is on the shelf.
                  </p>
                </div>
                <Switch
                  checked={item.trackInventory}
                  disabled={!canManage || policy.isPending}
                  label="Count stock"
                  onCheckedChange={(checked) => savePolicy({ trackInventory: checked })}
                />
              </div>

              {item.trackInventory ? (
                <Field
                  label="Low-stock warning at"
                  hint={
                    item.lowStockThreshold === null
                      ? `Using the store default of ${formatNumber(item.effectiveLowStockThreshold)}. Leave blank to keep it.`
                      : 'Blank restores the store default, which is not the same as zero.'
                  }
                >
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={threshold}
                      disabled={!canManage || policy.isPending}
                      placeholder={String(item.effectiveLowStockThreshold)}
                      onChange={(event) => setThreshold(event.target.value)}
                    />
                    {canManage && thresholdDirty ? (
                      <Button
                        size="sm"
                        isLoading={policy.isPending}
                        onClick={() =>
                          savePolicy({
                            lowStockThreshold: threshold === '' ? null : Number(threshold),
                          })
                        }
                      >
                        Save
                      </Button>
                    ) : null}
                  </div>
                </Field>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>

      <StockMoveDialog kind={moving} item={item} onClose={() => setMoving(null)} />
    </>
  )
}
