import { useState, type ReactNode } from 'react'
import { Mail, MessageSquare, Tag, Trash2, UserPlus, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import { formatDateTime } from '@/lib/format'
import {
  useAddCustomerNote,
  useCustomerEvents,
  useDeleteCustomerNote,
} from '../hooks/customers.hooks'
import { MARKETING_LABELS, eventLabel, metaText } from './customerLabels'
import type { CustomerEvent, MarketingState } from '../types/customers.types'

export interface CustomerTimelineProps {
  customerId: string
  canWrite: boolean
}

/**
 * The running record: what the system observed and what staff wrote down, in
 * one feed, newest first.
 *
 * One feed rather than two lists because "we rang them about the delay" and
 * "they unsubscribed" only mean anything in the order they happened, and
 * interleaving two lists by eye is work nobody does.
 *
 * Notes can be deleted but never edited, and system observations cannot be
 * touched at all — the server refuses. A record of what somebody saw at a
 * moment stops being that the moment it can be rewritten.
 */
export function CustomerTimeline({ customerId, canWrite }: CustomerTimelineProps) {
  const { toast } = useToast()
  const query = useCustomerEvents(customerId)
  const addNote = useAddCustomerNote(customerId)
  const deleteNote = useDeleteCustomerNote(customerId)

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
        description="What the shop did and what staff noticed, newest first."
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
              {query.data.map((event, index) => (
                <li key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="bg-surface-sunken text-muted border-line flex size-7 shrink-0 items-center justify-center rounded-full border">
                      <EventIcon kind={event.kind} />
                    </span>
                    {index < query.data.length - 1 ? (
                      <span aria-hidden="true" className="bg-line w-px flex-1" />
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1 pb-5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-ink text-sm">
                        <EventBody event={event} />
                      </p>

                      {event.kind === 'note' && canWrite ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label="Delete this note"
                          className="hover:text-danger shrink-0"
                          onClick={() => setRemoving(event.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>

                    <p className="text-faint mt-0.5 text-xs">
                      {formatDateTime(event.at)}
                      {event.actorName ? ` · ${event.actorName}` : ' · system'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted text-sm">Nothing has been recorded for this customer yet.</p>
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
        The note disappears from the timeline. Nothing else about the customer changes.
      </ConfirmDialog>
    </Card>
  )
}

function EventIcon({ kind }: { kind: string }): ReactNode {
  if (kind === 'note') return <MessageSquare className="size-3.5" />
  if (kind.startsWith('tags')) return <Tag className="size-3.5" />
  if (kind.startsWith('marketing')) return <Mail className="size-3.5" />
  if (kind === 'customer.merged') return <Users className="size-3.5" />
  return <UserPlus className="size-3.5" />
}

/**
 * Each kind rendered on its own terms.
 *
 * A consent change says which channel moved and where from — "marketing consent
 * changed" on its own is the entry somebody reads and then has to go looking
 * for the answer anyway.
 */
function EventBody({ event }: { event: CustomerEvent }): ReactNode {
  if (event.kind === 'note') return event.body

  if (event.kind === 'marketing.consent_changed') {
    const channel = metaText(event.metadata.channel, 'email')
    const from = MARKETING_LABELS[event.metadata.from as MarketingState] ?? '—'
    const to = MARKETING_LABELS[event.metadata.to as MarketingState] ?? '—'
    return (
      <>
        <span className="font-medium">{channel === 'sms' ? 'SMS' : 'Email'} marketing</span>{' '}
        <span className="text-muted">
          {from} → {to}
        </span>
      </>
    )
  }

  if (event.kind === 'tags.added' || event.kind === 'tags.removed') {
    const tags = Array.isArray(event.metadata.tags) ? (event.metadata.tags as string[]) : []
    return (
      <>
        <span className="font-medium">{eventLabel(event.kind)}</span>{' '}
        <span className="text-muted">{tags.join(', ')}</span>
      </>
    )
  }

  if (event.kind === 'customer.merged') {
    return (
      <>
        <span className="font-medium">Merged</span>{' '}
        <span className="text-muted">
          {metaText(event.metadata.mergedEmail, 'a duplicate record')} was folded into this
          customer
        </span>
      </>
    )
  }

  return (
    <>
      <span className="font-medium">{eventLabel(event.kind)}</span>
      {event.body ? <span className="text-muted"> {event.body}</span> : null}
    </>
  )
}
