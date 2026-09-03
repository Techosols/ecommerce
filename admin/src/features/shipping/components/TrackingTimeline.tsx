import { useState } from 'react'
import { ChevronDown, ChevronRight, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { formatDateTime } from '@/lib/format'
import { useTracking } from '../hooks/carrier.hooks'
import type { ShipmentStatus, TrackingEvent } from '../types/carrier.types'

export interface TrackingTimelineProps {
  shipmentId: string
  /** False when no courier reports tracking — then there is nothing to fetch. */
  enabled: boolean
}

const TONES: Record<ShipmentStatus, 'neutral' | 'info' | 'positive' | 'warning' | 'danger'> = {
  pending: 'neutral',
  processing: 'neutral',
  shipped: 'info',
  in_transit: 'info',
  delivered: 'positive',
  returned: 'warning',
  failed: 'danger',
}

const LABELS: Record<ShipmentStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  shipped: 'Shipped',
  in_transit: 'In transit',
  delivered: 'Delivered',
  returned: 'Returned',
  failed: 'Failed',
}

/**
 * Where a parcel has actually been, according to the courier.
 *
 * ── Why it is collapsed by default ───────────────────────────────────────────
 *
 * An order page is read to answer "what is happening with this order", and the
 * shipment's current status answers that. The scan trail answers the next
 * question — "why does it say that" — which is only asked when the first answer
 * is surprising. Collapsed also means the request is not made at all until
 * somebody wants it, so an order with four shipments does not fetch four
 * histories nobody looked at.
 *
 * ── Why the courier's own words are shown ────────────────────────────────────
 *
 * Both the mapped status and the courier's raw code, side by side. The mapped
 * one is what the system acted on; the raw one is the only way anybody can tell
 * a genuine "returned to sender" from a mis-mapping of some depot code — and
 * that question is always asked weeks later, when the raw value is the only
 * evidence left.
 */
export function TrackingTimeline({ shipmentId, enabled }: TrackingTimelineProps) {
  const [open, setOpen] = useState(false)
  const query = useTracking(open ? shipmentId : null, { enabled })

  if (!enabled) return null

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-muted hover:text-ink inline-flex items-center gap-1 text-xs"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Courier scans
      </button>

      {open ? (
        <div className="mt-2">
          <QueryBoundary
            isLoading={query.isPending}
            error={query.error}
            onRetry={() => void query.refetch()}
          >
            {query.data && query.data.length > 0 ? (
              <ol className="border-line ml-1.5 space-y-3 border-l pl-4">
                {query.data.map((event) => (
                  <Scan key={event.id} event={event} />
                ))}
              </ol>
            ) : (
              /* Not an error: a parcel booked five minutes ago has no scans, and
                 saying so is more useful than an empty box. */
              <p className="text-muted text-xs">
                The courier has not reported anything for this parcel yet.
              </p>
            )}
          </QueryBoundary>
        </div>
      ) : null}
    </div>
  )
}

function Scan({ event }: { event: TrackingEvent }) {
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" tone={TONES[event.status] ?? 'neutral'}>
          {LABELS[event.status] ?? event.status}
        </Badge>
        <span className="text-ink">{event.description}</span>
      </div>
      <div className="text-faint mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
        <span>{formatDateTime(event.occurredAt)}</span>
        {event.location ? (
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" />
            {event.location}
          </span>
        ) : null}
        <span>{event.provider}</span>
        {event.rawStatus ? <code className="font-mono">{event.rawStatus}</code> : null}
      </div>
    </li>
  )
}
