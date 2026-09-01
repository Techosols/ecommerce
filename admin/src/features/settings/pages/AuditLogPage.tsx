import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatDateTime } from '@/lib/format'
import { AuditEntry } from '../components/AuditEntry'
import { useAuditLogs } from '../hooks/settings.hooks'

/** The resource kinds worth filtering by. `action` is free text beside it. */
const RESOURCE_TYPES = [
  { value: '', label: 'Everything' },
  { value: 'order', label: 'Orders' },
  { value: 'product', label: 'Products' },
  { value: 'customer', label: 'Customers' },
  { value: 'refund', label: 'Refunds' },
  { value: 'return', label: 'Returns' },
  { value: 'discount', label: 'Discounts' },
  { value: 'inventory_item', label: 'Inventory' },
  { value: 'shipping_zone', label: 'Shipping' },
  { value: 'store_settings', label: 'Settings' },
  { value: 'user', label: 'Staff' },
]

/**
 * Who changed what.
 *
 * Read-only, and not by omission: an audit trail with an edit button is not
 * evidence of anything. Every row shows the actor, the action, the thing acted
 * on and — where the server recorded them — the before and after, so a
 * question like "who moved this price" has an answer rather than a suspicion.
 *
 * `audit:read` is owner-only on the server. Reading what people with power did
 * is itself a privileged act, so the page is behind the same permission rather
 * than showing an empty table to everybody else.
 */
export function AuditLogPage() {
  const [params, setParams] = useSearchParams()
  useDocumentTitle('Audit trail')

  const page = Number(params.get('page') ?? '1')
  const resourceType = params.get('resourceType') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''

  const [action, setAction] = useState(params.get('action') ?? '')
  const debouncedAction = useDebouncedValue(action, 300)

  function set(key: string, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  // The server takes a full timestamp; the inputs are dates. Widened to the
  // whole day at both ends, or "to: today" would exclude everything since
  // midnight — which is most of what somebody investigating is looking for.
  const query = useAuditLogs({
    page,
    limit: 25,
    ...(debouncedAction.includes('.') ? { action: debouncedAction } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
  })

  const isFiltered = Boolean(debouncedAction || resourceType || from || to)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit trail"
        description="Every administrative change, as it was recorded. Nothing here can be edited."
      />

      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={isFiltered}
            onClear={() => {
              setAction('')
              setParams(new URLSearchParams(), { replace: true })
            }}
            search={
              <SearchInput
                size="sm"
                aria-label="Filter by action"
                placeholder="order.refunded…"
                value={action}
                onChange={(event) => setAction(event.target.value)}
                onClear={() => setAction('')}
              />
            }
            filters={
              <>
                <Select
                  size="sm"
                  aria-label="Kind"
                  value={resourceType}
                  onChange={(event) => set('resourceType', event.target.value)}
                  options={RESOURCE_TYPES}
                />
                {/* Width pinned: a date input left to itself takes the whole
                    filter row and pushes everything else onto its own line. */}
                <Input
                  type="date"
                  size="sm"
                  aria-label="From"
                  className="w-36"
                  value={from}
                  onChange={(event) => set('from', event.target.value)}
                />
                <Input
                  type="date"
                  size="sm"
                  aria-label="To"
                  className="w-36"
                  value={to}
                  onChange={(event) => set('to', event.target.value)}
                />
              </>
            }
          />

          {action && !action.includes('.') ? (
            <p className="text-muted mt-2 text-xs">
              An action is written <span className="text-ink">resource.verb</span> — try{' '}
              <button
                type="button"
                className="text-brand-600 hover:underline"
                onClick={() => setAction('order.refunded')}
              >
                order.refunded
              </button>
              .
            </p>
          ) : null}
        </div>

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data && query.data.items.length > 0 ? (
            <ol className="divide-line divide-y">
              {query.data.items.map((record) => (
                <AuditEntry key={record.id} record={record} />
              ))}
            </ol>
          ) : (
            <EmptyState
              icon={<ScrollText className="size-5" />}
              title={isFiltered ? 'Nothing matches those filters' : 'Nothing recorded yet'}
              description={
                isFiltered
                  ? 'Try a wider date range, or clear the filters.'
                  : 'Administrative changes appear here as they happen.'
              }
              actions={
                isFiltered ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setAction('')
                      setParams(new URLSearchParams(), { replace: true })
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          )}

          {query.data && query.data.items.length > 0 ? (
            <div className="border-line flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 sm:px-5">
              <span className="text-faint text-xs">
                Newest first
                {query.data.items[0]
                  ? ` · latest ${formatDateTime(query.data.items[0].createdAt)}`
                  : ''}
              </span>
              <Pagination
                pagination={query.data.pagination}
                onPageChange={(next) =>
                  setParams((current) => {
                    const search = new URLSearchParams(current)
                    search.set('page', String(next))
                    return search
                  })
                }
              />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>
    </div>
  )
}
