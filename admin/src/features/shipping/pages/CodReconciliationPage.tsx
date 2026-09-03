import { useState } from 'react'
import { Banknote, FileUp, Upload } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { DataTable, type Column } from '@/components/ui/Table'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import {
  useCarrierCapabilities,
  useImportRemittance,
  useRemittance,
  useRemittances,
  useSettleCodLine,
} from '../hooks/carrier.hooks'
import type { CodMatchStatus, CodRemittance, CodRemittanceLine } from '../types/carrier.types'

/**
 * Reconciling the cash a courier collected at the door.
 *
 * ── What this screen is for ──────────────────────────────────────────────────
 *
 * In a cash-on-delivery shop the courier is the cashier: it takes the money,
 * keeps its fee, and pays over a batch weeks later with a list of parcels
 * attached. Working out which orders that batch actually paid for is otherwise
 * somebody's afternoon with a spreadsheet, every week.
 *
 * ── Why the mismatches come first ────────────────────────────────────────────
 *
 * Because they are the reason to open this at all. A statement where everything
 * agrees needs a glance; one where three lines are short needs a person, and
 * burying those three under two hundred that were fine is how they stay unseen
 * until the quarter closes. The server orders the lines this way and the table
 * keeps that order.
 *
 * ── Why there is no "settle everything" ──────────────────────────────────────
 *
 * Every settlement records a payment, confirms the order and commits its stock.
 * One button doing that for a whole parsed spreadsheet is precisely the
 * destructive bulk action this admin does not offer — and the server would
 * refuse it anyway, since it accepts one line per request. A mismatched line
 * cannot be settled here at all: the operator has to decide who is right and
 * record the payment on the order itself, with their own name against it.
 */
export function CodReconciliationPage() {
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Cash on delivery')

  const carrier = useCarrierCapabilities()
  const [page, setPage] = useState(1)
  const statements = useRemittances(page)
  const [openId, setOpenId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const canImport = can('payments:capture') && Boolean(carrier.data?.canImportRemittances)

  const columns: Column<CodRemittance>[] = [
    {
      id: 'reference',
      header: 'Statement',
      cell: (row) => (
        <button
          type="button"
          className="text-brand-700 dark:text-brand-300 text-left font-medium hover:underline"
          onClick={() => setOpenId(row.id)}
        >
          {row.reference ?? row.sourceFilename ?? 'Untitled statement'}
        </button>
      ),
    },
    {
      id: 'date',
      header: 'Statement date',
      cell: (row) => (
        <span className="text-muted">
          {row.statementDate ? formatDate(row.statementDate) : formatDateTime(row.importedAt)}
        </span>
      ),
      hideBelow: 'md',
    },
    {
      id: 'findings',
      header: 'Findings',
      cell: (row) => <Findings totals={row.totals} />,
    },
    {
      id: 'net',
      header: 'Paid over',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {formatMoney({ amount: row.totals.netCents, currency: row.currency })}
        </span>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Cash on delivery"
        description="What the courier collected at the door, and whether it adds up."
        actions={
          canImport ? (
            <Button leadingIcon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
              Import statement
            </Button>
          ) : undefined
        }
      />

      {/* Said plainly rather than shown as a disabled button: the reason there
          is nothing to do here is a configuration fact, and an operator who
          cannot see it will keep looking for the button. */}
      {carrier.data && !carrier.data.canImportRemittances ? (
        <Alert tone="info" title="No courier statements to import">
          {carrier.data.provider === 'manual'
            ? 'No courier is connected, so there are no statements to read. Cash collected on delivery is recorded on each order instead.'
            : `${carrier.data.label} does not provide cash-on-delivery statements. Record collections on each order instead.`}
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Statements" description="Newest first, by the date on the statement." />
        <CardBody>
          <QueryBoundary
            isLoading={statements.isPending}
            error={statements.error}
            onRetry={() => void statements.refetch()}
          >
            {statements.data && statements.data.items.length > 0 ? (
              <>
                <DataTable
                  rows={statements.data.items}
                  columns={columns}
                  getRowId={(row) => row.id}
                />
                <Pagination pagination={statements.data.pagination} onPageChange={setPage} />
              </>
            ) : (
              <EmptyState
                icon={<Banknote className="size-6" />}
                title="No statements yet"
                description="Import a courier's cash-on-delivery statement to reconcile it against your orders."
              />
            )}
          </QueryBoundary>
        </CardBody>
      </Card>

      {openId ? <StatementDrawer id={openId} onClose={() => setOpenId(null)} /> : null}

      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(remittance) => {
          setImporting(false)
          setOpenId(remittance.id)
          toast({
            tone: remittance.totals.matched === remittance.totals.lines ? 'success' : 'warning',
            title: `${remittance.totals.lines} lines imported`,
            description:
              remittance.totals.mismatched + remittance.totals.unmatched === 0
                ? 'Everything agrees with your orders.'
                : `${remittance.totals.mismatched} disagree and ${remittance.totals.unmatched} could not be matched.`,
          })
        }}
      />
    </div>
  )
}

/** The three findings, as counts. Zeroes are omitted rather than shown as 0. */
function Findings({ totals }: { totals: CodRemittance['totals'] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {totals.matched > 0 ? (
        <Badge size="sm" tone="positive">
          {totals.matched} matched
        </Badge>
      ) : null}
      {totals.mismatched > 0 ? (
        <Badge size="sm" tone="danger">
          {totals.mismatched} disagree
        </Badge>
      ) : null}
      {totals.unmatched > 0 ? (
        <Badge size="sm" tone="warning">
          {totals.unmatched} unmatched
        </Badge>
      ) : null}
    </div>
  )
}

const MATCH_TONES: Record<CodMatchStatus, 'positive' | 'danger' | 'warning'> = {
  matched: 'positive',
  mismatched: 'danger',
  unmatched: 'warning',
}

const MATCH_LABELS: Record<CodMatchStatus, string> = {
  matched: 'Matched',
  mismatched: 'Disagrees',
  unmatched: 'Unmatched',
}

function StatementDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth()
  const { toast } = useToast()
  const query = useRemittance(id)
  const settle = useSettleCodLine()
  const [settling, setSettling] = useState<CodRemittanceLine | null>(null)

  const canSettle = can('payments:capture')

  return (
    <Modal isOpen onClose={onClose} title="Statement" size="lg">
      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {query.data ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Fact label="Reference" value={query.data.reference ?? '—'} />
              <Fact
                label="Statement date"
                value={query.data.statementDate ? formatDate(query.data.statementDate) : '—'}
              />
              <Fact
                label="Collected"
                value={formatMoney({
                  amount: query.data.totals.collectedCents,
                  currency: query.data.currency,
                })}
              />
              <Fact
                label="Paid over"
                value={formatMoney({
                  amount: query.data.totals.netCents,
                  currency: query.data.currency,
                })}
              />
            </dl>

            {/* The courier's own covering figure against what its lines add up
                to. A gap here is the courier's arithmetic, not ours, and it is
                worth seeing before any individual line is argued about. */}
            {query.data.declaredNetCents !== query.data.totals.netCents ? (
              <Alert tone="warning" title="The statement does not add up">
                {query.data.provider} says it paid{' '}
                {formatMoney({
                  amount: query.data.declaredNetCents,
                  currency: query.data.currency,
                })}
                , but its own lines come to{' '}
                {formatMoney({ amount: query.data.totals.netCents, currency: query.data.currency })}
                .
              </Alert>
            ) : null}

            <ul className="divide-line border-line divide-y rounded-lg border">
              {query.data.lines.map((line) => (
                <li key={line.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge size="sm" tone={MATCH_TONES[line.matchStatus]}>
                        {MATCH_LABELS[line.matchStatus]}
                      </Badge>
                      <span className="text-ink font-medium">
                        {line.orderNumber ?? line.trackingNumber}
                      </span>
                      {line.settled ? (
                        <Badge size="sm" tone="neutral">
                          Recorded
                        </Badge>
                      ) : null}
                    </div>
                    <span className="text-faint block text-xs">
                      {line.trackingNumber}
                      {line.collectedAt ? ` · ${formatDate(line.collectedAt)}` : ''}
                    </span>
                  </div>

                  <div className="text-right">
                    <span className="text-ink block tabular-nums">
                      {formatMoney({ amount: line.collectedCents, currency: line.currency })}
                    </span>
                    {/* Only where they differ: repeating the same number twice
                        on every matched line would bury the ones that don't. */}
                    {line.expectedCents !== null && line.expectedCents !== line.collectedCents ? (
                      <span className="text-danger block text-xs tabular-nums">
                        order owed{' '}
                        {formatMoney({ amount: line.expectedCents, currency: line.currency })}
                      </span>
                    ) : null}
                  </div>

                  {canSettle && line.matchStatus === 'matched' && !line.settled ? (
                    <Button size="sm" variant="secondary" onClick={() => setSettling(line)}>
                      Record payment
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </QueryBoundary>

      <ConfirmDialog
        isOpen={settling !== null}
        onCancel={() => setSettling(null)}
        title="Record this payment?"
        confirmLabel="Record payment"
        isLoading={settle.isPending}
        onConfirm={() =>
          void (async () => {
            if (!settling) return
            try {
              await settle.mutateAsync(settling.id)
              toast({ tone: 'success', title: 'Payment recorded' })
              setSettling(null)
            } catch (error) {
              toast({ tone: 'error', title: messageOf(error) })
            }
          })()
        }
      >
        {settling ? (
          <>
            This marks order {settling.orderNumber} as paid for{' '}
            {formatMoney({ amount: settling.collectedCents, currency: settling.currency })} and
            confirms it, which commits its stock. It cannot be undone from here — a mistake is
            corrected with a refund.
          </>
        ) : null}
      </ConfirmDialog>
    </Modal>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint text-xs">{label}</dt>
      <dd className="text-ink tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * Reading a statement file.
 *
 * The file is read in the browser only to turn it into base64 for the request —
 * nothing here parses it. Which columns a courier's CSV has is the provider's
 * problem on the server, because that is where a second courier would otherwise
 * mean a second parser in a language that cannot be tested against the database.
 */
function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: (remittance: CodRemittance) => void
}) {
  const { toast } = useToast()
  const importStatement = useImportRemittance()
  const [file, setFile] = useState<File | null>(null)
  const [reference, setReference] = useState('')
  const [statementDate, setStatementDate] = useState('')
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setFile(null)
    setReference('')
    setStatementDate('')
    setError(null)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!file) {
      setError('Choose the statement file first.')
      return
    }

    try {
      const content = await toBase64(file)
      const remittance = await importStatement.mutateAsync({
        filename: file.name,
        content,
        reference: reference.trim() || null,
        statementDate: statementDate || null,
      })
      reset()
      onImported(remittance)
    } catch (caught) {
      const message = messageOf(caught)
      setError(message)
      toast({ tone: 'error', title: message })
    }
  }

  return (
    <Modal
      isOpen={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Import a statement"
    >
      {/* `noValidate`: the one mandatory field is a file, which the browser's
          own validation reports as an unlabelled bubble on a hidden input. The
          check below names it properly instead. */}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Statement file" hint="The CSV or spreadsheet the courier sent.">
          <input
            type="file"
            accept=".csv,.txt,.xlsx,.xls"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null)
              setError(null)
            }}
            className="text-muted file:bg-surface-hover file:text-ink hover:file:bg-surface-active block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>

        <Field
          label="Statement reference"
          hint="The courier's own number for this batch. Importing the same one twice is refused."
        >
          <Input value={reference} onChange={(event) => setReference(event.target.value)} />
        </Field>

        <Field label="Statement date" hint="The date on the statement, not today.">
          <Input
            type="date"
            value={statementDate}
            onChange={(event) => setStatementDate(event.target.value)}
          />
        </Field>

        {error ? (
          <Alert tone="danger" title="That statement was not imported">
            {error}
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            leadingIcon={<FileUp className="size-4" />}
            isLoading={importStatement.isPending}
          >
            Import
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The bytes, base64-encoded, without pulling the whole file through a string. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.onload = () => {
      const result = String(reader.result)
      // `readAsDataURL` gives `data:<type>;base64,<payload>`; the server wants
      // the payload alone.
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
