import { Link } from 'react-router-dom'
import { Check, Minus, Truck } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useCarrierCapabilities } from '../hooks/carrier.hooks'
import type { CarrierCapabilities } from '../types/carrier.types'

/**
 * Which courier is connected, and what it can actually do.
 *
 * ── Why the shop is told what it cannot do ───────────────────────────────────
 *
 * Because the alternative is an operator wondering where the "book with
 * courier" button went. Couriers differ enormously — some price and book over
 * an API and push scan events back, some have tracking and nothing else, some
 * hand over a spreadsheet once a week — so the four capabilities are listed
 * individually, present and absent alike, and the screens elsewhere show
 * exactly the controls this list says are possible.
 *
 * ── Why it is read-only ──────────────────────────────────────────────────────
 *
 * Choosing a courier is a deployment decision: it needs credentials, a callback
 * URL registered with the courier, and a restart. Putting a dropdown here would
 * suggest an operator could switch courier over lunch, and the first person to
 * try it would take the shop's booking offline.
 */
export function CarrierCard() {
  const query = useCarrierCapabilities()

  return (
    <Card>
      <CardHeader
        title="Courier"
        description="What the connected courier can do for this shop."
      />
      <CardBody>
        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data ? <Capabilities carrier={query.data} /> : null}
        </QueryBoundary>
      </CardBody>
    </Card>
  )
}

function Capabilities({ carrier }: { carrier: CarrierCapabilities }) {
  const connected = carrier.provider !== 'manual'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Truck className="text-muted size-4" />
        <span className="text-ink font-medium">{carrier.label}</span>
        <Badge size="sm" tone={connected ? 'positive' : 'neutral'}>
          {connected ? 'Connected' : 'Not connected'}
        </Badge>
      </div>

      <ul className="flex flex-col gap-1.5 text-sm">
        <Capability on={carrier.quotes}>
          Prices parcels live, and the cheaper of that and your own rate is what a shopper pays
        </Capability>
        <Capability on={carrier.booking}>
          Books the consignment when you create a shipment, and returns the tracking number
        </Capability>
        <Capability on={carrier.tracking}>
          Reports scans, which move the shipment on and email the customer
        </Capability>
        <Capability on={carrier.remittance}>
          Provides cash-on-delivery statements to{' '}
          <Link
            to="/payments/cod"
            className="text-brand-700 dark:text-brand-300 hover:underline"
          >
            reconcile
          </Link>
        </Capability>
      </ul>

      {!connected ? (
        <p className="text-muted text-xs">
          Delivery is priced by the rate card below, and staff enter the carrier and tracking
          number by hand when they ship a parcel.
        </p>
      ) : null}
    </div>
  )
}

function Capability({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {on ? (
        <Check className="text-positive mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <Minus className="text-faint mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <span className={on ? 'text-ink' : 'text-faint'}>
        <span className="sr-only">{on ? 'Available: ' : 'Not available: '}</span>
        {children}
      </span>
    </li>
  )
}
