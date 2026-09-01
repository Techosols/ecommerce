import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Pagination } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatDateTime, formatNumber } from '@/lib/format'
import { useLocations, useStockHistory } from '../hooks/inventory.hooks'
import { reasonLabel, reasonTone, signed } from './inventoryLabels'
import type { MovementReason } from '../types/inventory.types'

export interface StockLedgerProps {
  itemId: string
}

const REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Every reason' },
  { value: 'receive', label: 'Received a delivery' },
  { value: 'stocktake', label: 'Stock count' },
  { value: 'damage', label: 'Damaged' },
  { value: 'waste', label: 'Waste' },
  { value: 'return', label: 'Customer return' },
  { value: 'correction', label: 'Correction' },
  { value: 'manual_adjustment', label: 'Manual adjustment' },
  { value: 'transfer_in', label: 'Transferred in' },
  { value: 'transfer_out', label: 'Transferred out' },
  { value: 'reservation', label: 'Reserved' },
  { value: 'reservation_release', label: 'Reservation released' },
  { value: 'reservation_commit', label: 'Sold' },
  { value: 'reservation_expired', label: 'Reservation expired' },
]

/**
 * Every movement, newest first.
 *
 * The ledger is the evidence and the level is the running total, so this is
 * where a stock figure gets explained. Two things it shows that a simpler
 * history would not:
 *
 *   • **Both halves of the delta.** A reservation moves `reserved` without
 *     moving `onHand` — stock still on the shelf and no longer sellable — and
 *     a row showing only on-hand would render that as nothing happening.
 *   • **The resulting figure.** Each row says what the level became, so an
 *     operator reconciling against a paper count can find the row where the
 *     two stopped agreeing rather than adding deltas by hand.
 *
 * Nothing here is editable, because a ledger that can be rewritten is not
 * evidence of anything. A mistake is corrected by another movement.
 */
export function StockLedger({ itemId }: StockLedgerProps) {
  const [page, setPage] = useState(1)
  const [reason, setReason] = useState('')
  const [locationId, setLocationId] = useState('')

  const locations = useLocations()
  const query = useStockHistory(itemId, {
    page,
    limit: 20,
    ...(reason ? { reason: reason as MovementReason } : {}),
    ...(locationId ? { locationId } : {}),
  })

  const locationName = (id: string) =>
    (locations.data ?? []).find((entry) => entry.id === id)?.name ?? 'Unknown location'

  return (
    <Card>
      <CardHeader
        title="History"
        description="Every movement and why. Corrections are new entries; nothing here is edited."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              size="sm"
              aria-label="Filter by location"
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value)
                setPage(1)
              }}
              placeholder="All locations"
              options={(locations.data ?? []).map((location) => ({
                value: location.id,
                label: location.name,
              }))}
            />
            <Select
              size="sm"
              aria-label="Filter by reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value)
                setPage(1)
              }}
              options={REASON_OPTIONS}
            />
          </div>
        }
      />

      <CardBody>
        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data && query.data.items.length > 0 ? (
            <ol className="divide-line divide-y">
              {query.data.items.map((movement) => (
                <li key={movement.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                  <Badge size="sm" tone={reasonTone(movement.reason)}>
                    {reasonLabel(movement.reason)}
                  </Badge>

                  <span className="text-ink tabular text-sm font-medium">
                    {signed(movement.delta.onHand)}
                    <span className="text-faint ml-1 text-xs font-normal">on hand</span>
                  </span>

                  {/* Only when it moved: a zero here is noise on every row that
                      is not a reservation. */}
                  {movement.delta.reserved !== 0 ? (
                    <span className="text-muted tabular text-sm">
                      {signed(movement.delta.reserved)}
                      <span className="text-faint ml-1 text-xs">reserved</span>
                    </span>
                  ) : null}

                  <span className="text-faint text-xs">
                    → {formatNumber(movement.resulting.onHand)} on hand
                  </span>

                  <span className="text-faint ml-auto text-xs">
                    {locationName(movement.locationId)} · {formatDateTime(movement.createdAt)}
                  </span>

                  {movement.note ? (
                    <p className="text-muted basis-full text-xs">{movement.note}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted text-sm">
              {reason || locationId
                ? 'No movements match those filters.'
                : 'Nothing has moved yet.'}
            </p>
          )}

          {query.data && query.data.pagination.totalPages > 1 ? (
            <div className="border-line mt-3 border-t pt-3">
              <Pagination pagination={query.data.pagination} onPageChange={setPage} />
            </div>
          ) : null}
        </QueryBoundary>
      </CardBody>
    </Card>
  )
}
