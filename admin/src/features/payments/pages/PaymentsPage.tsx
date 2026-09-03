import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BanknoteArrowUp, Inbox } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { FilterBar } from '@/components/ui/FilterBar'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { SimplePager } from '@/components/ui/SimplePager'
import { DataTable, type Column } from '@/components/ui/Table'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { isApiError, messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney } from '@/lib/format'
import { ProofCard } from '../components/ProofCard'
import { RejectProofDialog } from '../components/RejectProofDialog'
import { methodLabels, statusLabels, statusTones } from '../components/paymentLabels'
import {
  useApproveProof,
  usePaymentProofs,
  usePayments,
  useRejectProof,
} from '../hooks/payments.hooks'
import type {
  PaymentMethod,
  PaymentProof,
  PaymentRow,
  PaymentStatus,
  ProofStatus,
} from '../types/payments.types'

/**
 * The two views a shop's money needs, and why they are not one screen.
 *
 * **To review** is a *queue*: a short list of things that need a decision
 * today, worked oldest first and then empty. **All payments** is a *ledger*:
 * everything that ever happened, read when reconciling or answering "did this
 * customer actually pay". A queue that has to be filtered out of a ledger is a
 * queue nobody works, so they are separate tabs and the queue is first.
 *
 * The receipt count rides on the tab. Somebody arriving at this page needs to
 * know whether there is anything to do before they choose where to look.
 */

const METHODS: PaymentMethod[] = ['cod', 'bank_transfer', 'card', 'manual']
const STATUSES: PaymentStatus[] = [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
]

type TabId = 'review' | 'ledger'

export function PaymentsPage() {
  const [params, setParams] = useSearchParams()
  useDocumentTitle('Payments')

  const tab = (params.get('tab') === 'ledger' ? 'ledger' : 'review') as TabId

  function patch(next: Record<string, string | undefined>) {
    setParams(
      (current) => {
        const search = new URLSearchParams(current)
        for (const [key, value] of Object.entries(next)) {
          if (value) search.set(key, value)
          else search.delete(key)
        }
        // Any change of filter or view starts again at the first page —
        // otherwise switching tabs lands on page 4 of something else. Paging
        // itself is the one caller that means to set it, and says so.
        if (!('page' in next)) search.delete('page')
        return search
      },
      { replace: true },
    )
  }

  // Read here rather than inside the tab so the count can sit on the tab label.
  const queue = usePaymentProofs({ page: 1, limit: 50, status: 'submitted' })
  const pending = (queue.data?.meta?.pending as number | undefined) ?? queue.data?.items.length ?? 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Payments"
        description="Money taken, money returned, and receipts waiting to be checked."
      />

      <Tabs
        items={[
          {
            id: 'review',
            label: 'To review',
            ...(pending > 0 ? { count: pending } : {}),
          },
          { id: 'ledger', label: 'All payments' },
        ]}
        value={tab}
        onChange={(next) => patch({ tab: next === 'review' ? undefined : next })}
      />

      {tab === 'review' ? <ReviewQueue /> : <Ledger params={params} onPatch={patch} />}
    </div>
  )
}

// ── The queue ────────────────────────────────────────────────────────────────

function ReviewQueue() {
  const { can } = useAuth()
  const { toast } = useToast()
  const [showDecided, setShowDecided] = useState(false)
  const [rejecting, setRejecting] = useState<PaymentProof | null>(null)
  const [approving, setApproving] = useState<PaymentProof | null>(null)

  const status: ProofStatus | undefined = showDecided ? undefined : 'submitted'
  const query = usePaymentProofs({ page: 1, limit: 50, ...(status ? { status } : {}) })

  const approve = useApproveProof()
  const reject = useRejectProof()
  const canDecide = can('payments:capture')

  function onApproved() {
    const proof = approving
    if (!proof) return
    approve.mutate(proof.id, {
      onSuccess: () => {
        setApproving(null)
        toast({
          tone: 'success',
          title: 'Payment recorded',
          description: proof.order
            ? `${proof.order.orderNumber} is paid and confirmed.`
            : 'The order is paid and confirmed.',
        })
      },
      onError: (error) => {
        setApproving(null)
        toast({
          tone: isApiError(error) && error.code === 'CONCURRENT_MODIFICATION' ? 'warning' : 'error',
          title: 'Could not approve that receipt',
          description: messageOf(error),
        })
      },
    })
  }

  function onRejected(note: string) {
    const proof = rejecting
    if (!proof) return
    reject.mutate(
      { id: proof.id, note },
      {
        onSuccess: () => {
          setRejecting(null)
          toast({ tone: 'info', title: 'Receipt rejected', description: 'The order stays unpaid.' })
        },
        onError: (error) => {
          setRejecting(null)
          toast({
            tone: 'error',
            title: 'Could not reject that receipt',
            description: messageOf(error),
          })
        },
      },
    )
  }

  return (
    <>
      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {(query.data?.items.length ?? 0) === 0 ? (
          <Card>
            <EmptyState
              icon={<Inbox className="size-6" />}
              title={showDecided ? 'No receipts yet' : 'Nothing to review'}
              description={
                showDecided
                  ? 'Receipts customers send for bank transfers will appear here.'
                  : 'Every receipt sent so far has been dealt with.'
              }
              actions={
                showDecided ? undefined : (
                  <button
                    type="button"
                    onClick={() => setShowDecided(true)}
                    className="text-brand-600 text-sm hover:underline"
                  >
                    Show ones already decided
                  </button>
                )
              }
            />
          </Card>
        ) : (
          /* Capped, unlike the ledger. A table earns the full window because
             comparing rows is the job; this queue is read one card at a time,
             and at 1400px the order total sits a head-turn away from the
             screenshot it has to be checked against. */
          <div className="flex max-w-[60rem] flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-muted text-xs">
                {showDecided
                  ? `${query.data?.pagination.total ?? 0} receipts`
                  : `${query.data?.items.length ?? 0} waiting · oldest first`}
              </p>
              <button
                type="button"
                onClick={() => setShowDecided((current) => !current)}
                className="text-brand-600 text-xs hover:underline"
              >
                {showDecided ? 'Show only what needs a decision' : 'Include decided'}
              </button>
            </div>

            {query.data?.items.map((proof) => (
              <ProofCard
                key={proof.id}
                proof={proof}
                canDecide={canDecide}
                isBusy={approve.isPending || reject.isPending}
                onApprove={setApproving}
                onReject={setRejecting}
              />
            ))}
          </div>
        )}
      </QueryBoundary>

      {/* Approving moves money and confirms an order. Never one click. */}
      <ConfirmDialog
        isOpen={approving !== null}
        title="Record this payment?"
        confirmLabel={approve.isPending ? 'Recording…' : 'Yes, record it'}
        isLoading={approve.isPending}
        onConfirm={onApproved}
        onCancel={() => setApproving(null)}
      >
        {approving?.order
          ? `${approving.order.orderNumber} will be marked paid for ${formatMoney(approving.order.total)} and confirmed, ready to fulfil. Check the receipt against your bank statement first — this cannot be undone from here.`
          : 'The order will be marked paid and confirmed.'}
      </ConfirmDialog>

      <RejectProofDialog
        proof={rejecting}
        isSaving={reject.isPending}
        onCancel={() => setRejecting(null)}
        onConfirm={onRejected}
      />
    </>
  )
}

// ── The ledger ───────────────────────────────────────────────────────────────

function Ledger({
  params,
  onPatch,
}: {
  params: URLSearchParams
  onPatch: (next: Record<string, string | undefined>) => void
}) {
  const page = Number(params.get('page') ?? '1')
  const method = (params.get('method') ?? '') as PaymentMethod | ''
  const status = (params.get('status') ?? '') as PaymentStatus | ''

  const query = usePayments({
    page,
    limit: 20,
    ...(method ? { method } : {}),
    ...(status ? { status } : {}),
  })

  const columns = useMemo<Array<Column<PaymentRow>>>(
    () => [
      {
        id: 'order',
        header: 'Order',
        cell: (row) => (
          <div className="min-w-0">
            <Link
              to={`/orders/${row.orderId}`}
              className="text-brand-600 font-medium hover:underline"
            >
              {row.orderNumber}
            </Link>
            <p className="text-faint max-w-[14rem] truncate text-xs">{row.orderEmail}</p>
          </div>
        ),
      },
      {
        id: 'method',
        header: 'Method',
        hideBelow: 'sm',
        cell: (row) => <span className="whitespace-nowrap">{methodLabels[row.method]}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        cell: (row) => (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={statusTones[row.status]} size="sm">
              {statusLabels[row.status]}
            </Badge>
            {row.failureMessage ? (
              <span className="text-danger max-w-[16rem] truncate text-xs" title={row.failureMessage}>
                {row.failureMessage}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        align: 'right',
        cell: (row) => (
          <div className="tabular whitespace-nowrap">
            <span className="text-ink">{formatMoney(row.amount)}</span>
            {row.refunded.amount > 0 ? (
              // Refunds belong beside the amount, not in their own column: the
              // question is always "how much of this did we keep".
              <p className="text-muted text-xs">−{formatMoney(row.refunded)} refunded</p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'taken',
        header: 'Taken',
        hideBelow: 'lg',
        cell: (row) => (
          <span className="text-muted whitespace-nowrap text-xs">
            {formatDateTime(row.capturedAt ?? row.createdAt)}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <Card>
      <FilterBar
        isFiltered={method !== '' || status !== ''}
        onClear={() => onPatch({ method: undefined, status: undefined })}
        filters={
          <>
            <Select
              aria-label="Filter by method"
              value={method}
              onChange={(event) => onPatch({ method: event.target.value || undefined })}
              options={[
                { value: '', label: 'All methods' },
                ...METHODS.map((key) => ({ value: key, label: methodLabels[key] })),
              ]}
            />
            <Select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => onPatch({ status: event.target.value || undefined })}
              options={[
                { value: '', label: 'Any status' },
                ...STATUSES.map((key) => ({ value: key, label: statusLabels[key] })),
              ]}
            />
          </>
        }
      />

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {(query.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            icon={<BanknoteArrowUp className="size-6" />}
            title="No payments match"
            description={
              method || status
                ? 'Nothing here fits those filters.'
                : 'Payments appear once an order is paid.'
            }
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={query.data?.items ?? []}
              getRowId={(row) => row.id}
            />
            {query.data ? (
              <SimplePager
                pagination={query.data.pagination}
                onPageChange={(next) => onPatch({ page: String(next) })}
              />
            ) : null}
          </>
        )}
      </QueryBoundary>
    </Card>
  )
}
