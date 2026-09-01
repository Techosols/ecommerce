import { useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Banknote,
  MessageSquare,
  RotateCcw,
  Trash2,
  Truck,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime, formatMoney } from '@/lib/format'
import {
  useAddOrderNote,
  useDeleteOrderNote,
  useOrderTimeline,
} from '../hooks/orders.hooks'
import { machineLabel, statusLabel } from './orderLabels'
import type { TimelineEntry } from '../types/orders.types'

export interface OrderTimelineProps {
  orderId: string
  canWrite: boolean
}

/**
 * Everything that happened to this order, newest first.
 *
 * The server assembles the feed from the status history, the notes, the
 * payments, the refunds and the shipments, and keeps the `kind` discriminator
 * rather than flattening each event into a sentence. So each kind is rendered
 * on its own terms here — a refund shows an amount and whether stock came back,
 * a shipment shows its carrier — instead of the page guessing what happened
 * from a string.
 *
 * Notes are written and deleted here and nowhere else. They cannot be edited,
 * which is deliberate: the feed is meant to be evidence of what somebody
 * observed at a moment, and evidence that can be rewritten is not.
 */
export function OrderTimeline({ orderId, canWrite }: OrderTimelineProps) {
  const { toast } = useToast()
  const query = useOrderTimeline(orderId)
  const addNote = useAddOrderNote(orderId)
  const deleteNote = useDeleteOrderNote(orderId)

  const [draft, setDraft] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)

  function submit() {
    const body = draft.trim()
    if (!body || addNote.isPending) return

    addNote.mutate(body, {
      onSuccess: () => setDraft(''),
      onError: (error) =>
        toast({ tone: 'error', title: 'Could not add the note', description: messageOf(error) }),
    })
  }

  return (
    <Card>
      <CardHeader
        title="Timeline"
        description="Status changes, payments, shipments and staff notes, newest first."
      />

      <CardBody className="flex flex-col gap-5">
        {canWrite ? (
          <div className="flex flex-col gap-2">
            <Textarea
              rows={2}
              value={draft}
              maxLength={2000}
              aria-label="Add an internal note"
              placeholder="Add an internal note. Only staff see these."
              disabled={addNote.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                disabled={draft.trim() === ''}
                isLoading={addNote.isPending}
                onClick={submit}
              >
                Add note
              </Button>
            </div>
          </div>
        ) : null}

        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          {query.data && query.data.length > 0 ? (
            <ol className="flex flex-col">
              {query.data.map((entry, index) => (
                <li key={entry.id} className="flex gap-3">
                  {/* The rail: a marker per entry, with a line joining it to the
                      next one. The last entry gets no line, so the feed ends
                      rather than trailing off. */}
                  <div className="flex flex-col items-center">
                    <span className="bg-surface-sunken text-muted border-line flex size-7 shrink-0 items-center justify-center rounded-full border">
                      <EntryIcon entry={entry} />
                    </span>
                    {index < query.data.length - 1 ? (
                      <span aria-hidden="true" className="bg-line w-px flex-1" />
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1 pb-5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-ink text-sm">
                        <EntryBody entry={entry} />
                      </p>

                      {entry.kind === 'note' && canWrite ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label="Delete this note"
                          className="hover:text-danger shrink-0"
                          onClick={() => setRemoving(entry.id.replace(/^note:/, ''))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>

                    <p className="text-faint mt-0.5 text-xs">
                      {formatDateTime(entry.at)}
                      {entry.actorName ? ` · ${entry.actorName}` : ' · system'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted text-sm">Nothing has happened to this order yet.</p>
          )}
        </QueryBoundary>
      </CardBody>

      <ConfirmDialog
        isOpen={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return
          deleteNote.mutate(removing, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Note deleted' })
              setRemoving(null)
            },
            onError: (error) => {
              toast({
                tone: 'error',
                title: 'Could not delete the note',
                description: messageOf(error),
              })
              setRemoving(null)
            },
          })
        }}
        title="Delete this note?"
        confirmLabel="Delete note"
        tone="danger"
        isLoading={deleteNote.isPending}
      >
        The note disappears from the timeline. Nothing else about the order changes.
      </ConfirmDialog>
    </Card>
  )
}

function EntryIcon({ entry }: { entry: TimelineEntry }): ReactNode {
  switch (entry.kind) {
    case 'note':
      return <MessageSquare className="size-3.5" />
    case 'payment':
      return <Banknote className="size-3.5" />
    case 'refund':
      return <RotateCcw className="size-3.5" />
    case 'shipment':
      return <Truck className="size-3.5" />
    case 'status':
      return <ArrowRight className="size-3.5" />
  }
}

function EntryBody({ entry }: { entry: TimelineEntry }): ReactNode {
  switch (entry.kind) {
    case 'note':
      return <span className="whitespace-pre-wrap">{entry.body}</span>

    case 'status':
      return (
        <>
          <span className="text-muted">{machineLabel(entry.field)}</span>{' '}
          {entry.from ? (
            <>
              <span className="text-muted">{statusLabel(entry.field, entry.from)}</span>
              <span className="text-faint"> → </span>
            </>
          ) : null}
          <span className="font-medium">{statusLabel(entry.field, entry.to)}</span>
          {entry.reason ? <span className="text-muted"> — {entry.reason}</span> : null}
        </>
      )

    case 'payment':
      return (
        <>
          <span className="font-medium">{formatMoney(entry.amount)}</span> received
          <span className="text-muted"> by {entry.method}</span>
        </>
      )

    case 'refund':
      return (
        <>
          <span className="font-medium">{formatMoney(entry.amount)}</span> refunded
          {entry.reason ? <span className="text-muted"> — {entry.reason}</span> : null}
          <span className="text-muted">
            {entry.restock ? ' · stock returned to the shelf' : ' · stock not returned'}
          </span>
        </>
      )

    case 'shipment':
      return (
        <>
          <span className="font-medium">
            {entry.itemCount} {entry.itemCount === 1 ? 'item' : 'items'}
          </span>{' '}
          shipped
          {entry.carrier ? <span className="text-muted"> by {entry.carrier}</span> : null}
          {entry.trackingNumber ? (
            <span className="text-faint font-mono text-xs"> {entry.trackingNumber}</span>
          ) : null}
        </>
      )
  }
}
