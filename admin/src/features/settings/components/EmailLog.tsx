import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, MinusCircle, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/Table'
import { Pagination } from '@/components/ui/Pagination'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { Tooltip } from '@/components/ui/Tooltip'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useEmailLog, useRetryEmail } from '../hooks/settings.hooks'
import type { EmailLogEntry, EmailLogStatus } from '../types/settings.types'

/**
 * What the shop actually sent, and what became of it.
 *
 * ── Why this screen exists ───────────────────────────────────────────────────
 *
 * "Nobody got the order email" has one symptom and six causes, and until this
 * screen the only way to tell them apart was a psql prompt. Each row here says
 * which one it was, in the provider's own words:
 *
 *   **Sent** — the mail server *accepted* it, and said so. That is a handover,
 *   not a delivery: everything after it happens on somebody else's machine.
 *   The server's own reply is shown beside the row — a `250 OK id=…` is the
 *   queue id a receiving postmaster can look up, and it is the difference
 *   between "our software says it sent" and evidence. If a message reads Sent
 *   and never arrived, the causes are an asynchronous bounce (which lands in
 *   the sending mailbox), a spam folder, SPF/DKIM/DMARC on the sending domain,
 *   or an outgoing filter on the host — in that order of likelihood.
 *
 *   **Waiting / Failed with a reason** — the mail server refused it. The reason
 *   is the server's: "relaying denied", "authentication failed", "no such
 *   user". That sentence is the fix.
 *
 *   **Off** — somebody switched that template off on this page.
 *
 *   **Suppressed** — the recipient asked the shop to stop.
 *
 * ── What it does not show ────────────────────────────────────────────────────
 *
 * No message bodies and no props: the server does not send them. The props of
 * an order email carry the customer's name and full delivery address, and a
 * screen about *delivery* should not quietly become a second place to read
 * them. Recipient, subject and outcome are what diagnose a delivery problem.
 */

const STATUS: Record<
  EmailLogStatus,
  { label: string; tone: 'neutral' | 'positive' | 'warning' | 'danger'; icon: typeof Clock; hint: string }
> = {
  sent: {
    label: 'Sent',
    tone: 'positive',
    icon: CheckCircle2,
    hint: 'The mail server accepted it and gave the reply shown. That is a handover, not proof of delivery — if it never arrived, check the sending mailbox for a bounce, then the recipient’s spam folder, then SPF/DKIM/DMARC on your domain.',
  },
  queued: {
    label: 'Waiting',
    tone: 'warning',
    icon: Clock,
    hint: 'Waiting to be sent, or waiting to be retried after a failure.',
  },
  sending: {
    label: 'Sending',
    tone: 'warning',
    icon: Loader2,
    hint: 'A worker has it right now.',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
    icon: XCircle,
    hint: 'It ran out of retries. The reason beside it is the mail server’s own.',
  },
  disabled: {
    label: 'Off',
    tone: 'neutral',
    icon: MinusCircle,
    hint: 'This template is switched off above, so it was recorded rather than sent.',
  },
  suppressed: {
    label: 'Suppressed',
    tone: 'neutral',
    icon: MinusCircle,
    hint: 'This address is on the suppression list — they asked us to stop.',
  },
}

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'failed', label: 'Failed' },
  { value: 'queued', label: 'Waiting' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'disabled', label: 'Switched off' },
  { value: 'suppressed', label: 'Suppressed' },
]

export function EmailLog({ canEdit = false }: { canEdit?: boolean }) {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [to, setTo] = useState('')
  const { toast } = useToast()
  const retry = useRetryEmail()

  const query = useEmailLog({
    page,
    ...(status ? { status } : {}),
    ...(to ? { to } : {}),
  })

  const summary = (query.data?.meta?.summary ?? {}) as Record<string, number>
  const trouble = (summary.failed ?? 0) + (summary.queued ?? 0) + (summary.sending ?? 0)

  const columns: Array<Column<EmailLogEntry>> = [
    {
      id: 'status',
      header: 'Status',
      width: '9rem',
      cell: (row) => {
        const state = STATUS[row.status] ?? STATUS.queued
        return (
          <Tooltip label={state.hint}>
            <span className="inline-flex">
              <Badge tone={state.tone}>{state.label}</Badge>
            </span>
          </Tooltip>
        )
      },
    },
    {
      id: 'to',
      header: 'To',
      cell: (row) => (
        <span className="text-ink block max-w-[16rem] truncate" title={row.to}>
          {row.to}
        </span>
      ),
    },
    {
      id: 'subject',
      header: 'Subject',
      hideBelow: 'md',
      cell: (row) => (
        <span className="text-muted block max-w-[20rem] truncate" title={row.subject}>
          {row.subject}
        </span>
      ),
    },
    {
      id: 'error',
      header: 'What happened',
      /*
       * One column, because an operator has one question — "what became of
       * it?" — and the answer is the provider's own sentence either way.
       *
       * A failure shows why it was refused. A success shows the receipt, which
       * is the row that used to say nothing at all and is exactly the row
       * somebody is staring at when they say "it claims it sent it".
       */
      cell: (row) => {
        if (row.lastError) {
          // "550 5.7.1 Relaying denied" tells an operator what to fix; a
          // generic message does not. Full text on hover.
          return (
            <span
              className="text-danger block max-w-[22rem] truncate text-xs"
              title={row.lastError}
            >
              {row.lastError}
            </span>
          )
        }

        if (row.providerResponse) {
          /*
           * Warned rather than reassured when nothing actually left.
           *
           * The console provider writes `.eml` files to disk and reports
           * success, so its rows read Sent like any other. Saying so here is
           * the whole point: an operator should not have to know what
           * EMAIL_PROVIDER is set to before believing the log.
           */
          const notReallySent = row.providerResponse.startsWith('Not sent.')
          return (
            <span
              className={
                notReallySent
                  ? 'text-warning block max-w-[22rem] truncate text-xs'
                  : 'text-muted block max-w-[22rem] truncate font-mono text-xs'
              }
              title={row.providerResponse}
            >
              {row.providerResponse}
            </span>
          )
        }

        return <span className="text-faint text-xs">—</span>
      },
    },
    {
      id: 'attempts',
      header: 'Tries',
      align: 'right',
      width: '4.5rem',
      hideBelow: 'sm',
      cell: (row) => <span className="text-muted text-xs">{row.attempts}</span>,
    },
    {
      id: 'retry',
      header: '',
      align: 'right',
      width: '6rem',
      // Offered only where it can do something. A retry on a delivered message
      // is refused by the server, and a button that only ever errors is worse
      // than no button.
      cell: (row) =>
        canEdit && (row.status === 'failed' || row.status === 'queued') ? (
          <Button
            size="xs"
            variant="ghost"
            isLoading={retry.isPending && retry.variables === row.id}
            onClick={() =>
              retry.mutate(row.id, {
                onSuccess: () => toast({ tone: 'success', title: 'Queued to send again' }),
                onError: (error) =>
                  toast({
                    tone: 'error',
                    title: 'Could not retry that',
                    description: messageOf(error),
                  }),
              })
            }
          >
            Retry
          </Button>
        ) : null,
    },
    {
      id: 'when',
      header: 'When',
      align: 'right',
      width: '10rem',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="text-muted text-xs">
          {new Date(row.sentAt ?? row.createdAt).toLocaleString()}
        </span>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader
        title="Delivery log"
        description="Every message the shop has tried to send, and what the mail server said about it."
      />
      <CardBody className="flex flex-col gap-3">
        {/* The one thing a page of successes hides. Shown only when there is
            something to say, so a healthy shop is not given a warning to
            learn to ignore. */}
        {trouble > 0 ? (
          <div className="border-warning/30 bg-warning-soft flex items-start gap-2 rounded-lg border px-3 py-2">
            <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="text-ink text-sm">
              {trouble} {trouble === 1 ? 'message has' : 'messages have'} not been delivered in the
              last 24 hours.{' '}
              <button
                type="button"
                className="text-brand-700 underline"
                onClick={() => {
                  setStatus('failed')
                  setPage(1)
                }}
              >
                Show the failures
              </button>
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setPage(1)
            }}
            className="w-44"
          >
            {FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>

          <SearchInput
            value={to}
            onChange={(event) => {
              setTo(event.target.value)
              setPage(1)
            }}
            onClear={() => {
              setTo('')
              setPage(1)
            }}
            placeholder="Search by address"
            className="max-w-64"
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
            isLoading={query.isPending}
            emptyState={
              <p className="text-muted py-8 text-center text-sm">
                {status || to
                  ? 'Nothing matches that.'
                  : 'The shop has not sent anything yet.'}
              </p>
            }
          />

          {query.data?.pagination ? (
            <Pagination pagination={query.data.pagination} onPageChange={setPage} />
          ) : null}
        </QueryBoundary>
      </CardBody>
    </Card>
  )
}
