import { Link } from 'react-router-dom'
import { AlertOctagon, Boxes, PackageCheck, Wallet, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { Skeleton } from '@/components/ui/Skeleton'
import type { OperationalCounters } from './dashboard.types'

interface Queue {
  key: keyof OperationalCounters
  label: string
  hint: string
  to: string
  icon: LucideIcon
  /** Above zero, this queue is a problem rather than a workload. */
  alarming?: boolean
}

const queues: Queue[] = [
  {
    key: 'awaitingPayment',
    label: 'Awaiting payment',
    hint: 'Placed, not yet paid',
    to: '/orders',
    icon: Wallet,
  },
  {
    key: 'awaitingFulfillment',
    label: 'To fulfil',
    hint: 'Confirmed, not yet shipped',
    to: '/orders',
    icon: PackageCheck,
  },
  {
    key: 'lowStock',
    label: 'Low stock',
    hint: 'At or under the threshold',
    to: '/inventory',
    icon: Boxes,
  },
  {
    key: 'outOfStock',
    label: 'Out of stock',
    hint: 'Nothing available to sell',
    to: '/inventory',
    icon: AlertOctagon,
    alarming: true,
  },
]

/**
 * The four numbers that decide what an operator does next.
 *
 * They lead the dashboard, above revenue, because this is a working screen: the
 * question at nine in the morning is "what is waiting for me", not "how did
 * last month go". Every figure is counted by the server in one query; nothing
 * here is derived in the browser.
 */
export function OperationsQueues({
  counters,
  isLoading,
}: {
  counters: OperationalCounters | undefined
  isLoading: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {queues.map((queue) => {
        const value = counters?.[queue.key]
        const needsAttention = (value ?? 0) > 0 && queue.alarming

        return (
          <Link
            key={queue.key}
            to={queue.to}
            className={cn(
              'bg-surface rounded-card shadow-card group border p-4 transition-colors sm:p-5',
              needsAttention
                ? 'border-danger/40 hover:border-danger'
                : 'border-line hover:border-line-strong',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-muted text-xs font-medium tracking-wide uppercase">
                {queue.label}
              </p>
              <queue.icon
                aria-hidden="true"
                className={cn('size-4 shrink-0', needsAttention ? 'text-danger' : 'text-faint')}
              />
            </div>

            {isLoading ? (
              <Skeleton className="mt-3 h-8 w-16" />
            ) : (
              <p
                className={cn(
                  'tabular mt-2 text-2xl font-semibold',
                  needsAttention ? 'text-danger' : 'text-ink',
                )}
              >
                {value === undefined ? '—' : formatNumber(value)}
              </p>
            )}

            <p className="text-faint mt-1 text-xs">{queue.hint}</p>
          </Link>
        )
      })}
    </div>
  )
}
