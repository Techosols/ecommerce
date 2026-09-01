import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FileText, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterBar } from '@/components/ui/FilterBar'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { DataTable, type Column } from '@/components/ui/Table'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney } from '@/lib/format'
import { draftState } from '../components/draftLabels'
import { useCreateDraft, useDrafts } from '../hooks/drafts.hooks'
import type { DraftSummary } from '../types/drafts.types'

/**
 * Orders staff are building by hand.
 *
 * The value column is the draft's lines as of the last edit, not a live quote:
 * re-pricing twenty rows against the catalogue to render a list would be a lot
 * of work for a figure nobody acts on. The builder re-quotes on open, and that
 * is the number that governs.
 */
export function DraftListPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Draft orders')

  const page = Number(params.get('page') ?? '1')
  const [search, setSearch] = useState(params.get('q') ?? '')
  const debounced = useDebouncedValue(search, 300)

  const query = useDrafts({ page, limit: 20, ...(debounced ? { q: debounced } : {}) })
  const create = useCreateDraft()
  const canWrite = can('orders:write')

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

  function start() {
    create.mutate(
      {},
      {
        onSuccess: (draft) => void navigate(`/drafts/${draft.id}`),
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not start a draft', description: messageOf(error) }),
      },
    )
  }

  const columns = useMemo<Array<Column<DraftSummary>>>(
    () => [
      {
        id: 'reference',
        header: 'Reference',
        cell: (row) => (
          <div className="min-w-0">
            <span className="text-ink block truncate font-medium">{row.reference}</span>
            <span className="text-faint block truncate text-xs">
              {row.email ?? 'No email yet'}
            </span>
          </div>
        ),
      },
      {
        id: 'value',
        header: 'Items',
        align: 'right',
        width: '9rem',
        cell: (row) => (
          <Tooltip label="The lines as of the last edit. Opening it re-prices against the catalogue.">
            <span className="text-ink tabular font-medium">{formatMoney(row.subtotal)}</span>
          </Tooltip>
        ),
      },
      {
        id: 'updated',
        header: 'Last touched',
        width: '12rem',
        hideBelow: 'sm',
        cell: (row) => <span className="text-muted text-sm">{formatDateTime(row.updatedAt)}</span>,
      },
      {
        id: 'state',
        header: 'State',
        width: '8rem',
        cell: (row) => {
          const state = draftState(row)
          return <Badge tone={state.tone}>{state.label}</Badge>
        },
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="border-line border-b px-4 py-3 sm:px-5">
          <FilterBar
            isFiltered={Boolean(debounced)}
            onClear={() => {
              setSearch('')
              setParams(new URLSearchParams(), { replace: true })
            }}
            search={
              <SearchInput
                size="sm"
                aria-label="Search drafts"
                placeholder="Reference or email…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  set('q', event.target.value)
                }}
                onClear={() => {
                  setSearch('')
                  set('q', '')
                }}
              />
            }
            trailing={
              canWrite ? (
                <Button
                  size="sm"
                  variant="primary"
                  isLoading={create.isPending}
                  leadingIcon={<Plus className="size-4" />}
                  onClick={start}
                >
                  New draft
                </Button>
              ) : null
            }
          />
        </div>

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            getRowId={(row) => row.id}
            caption="Draft orders"
            onRowClick={(row) => void navigate(`/drafts/${row.id}`)}
            emptyState={
              <EmptyState
                icon={<FileText className="size-5" />}
                title="No drafts"
                description="A draft is an order you build by hand — for a phone order, a quote, or a sale made in person. It reserves no stock until you place it."
                actions={
                  canWrite ? (
                    <Button variant="primary" isLoading={create.isPending} onClick={start}>
                      Start one
                    </Button>
                  ) : null
                }
              />
            }
          />

          {query.data?.pagination ? (
            <div className="border-line border-t px-4 py-3 sm:px-5">
              <Pagination
                pagination={query.data.pagination}
                onPageChange={(next) => set('page', String(next))}
              />
            </div>
          ) : null}
        </QueryBoundary>
      </Card>
    </div>
  )
}
