import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PageHeader } from '@/components/ui/PageHeader'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { DraftDetailsCard } from '../components/DraftDetailsCard'
import { DraftLinesCard } from '../components/DraftLinesCard'
import { DraftSummaryCard } from '../components/DraftSummaryCard'
import { draftState, draftTitle } from '../components/draftLabels'
import {
  useDiscardDraft,
  useDraft,
  usePlaceDraft,
  useSetDraftLines,
  useUpdateDraft,
} from '../hooks/drafts.hooks'
import type { DraftDetail, DraftLineInput, DraftPatch } from '../types/drafts.types'

/**
 * Building one order by hand.
 *
 * The shape of this screen follows from where the decisions live. Nothing here
 * decides anything: each edit is sent, the server re-prices the whole draft,
 * and what comes back is rendered. That is why the totals cannot drift from
 * what checkout will charge, and why "can this be placed" is a list of
 * sentences from the server rather than a condition evaluated in the browser.
 */
export function DraftBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const query = useDraft(id)
  useDocumentTitle('Draft order')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/drafts"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Drafts
        </Link>
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {query.data ? <Builder draft={query.data} /> : null}
      </QueryBoundary>
    </div>
  )
}

function Builder({ draft }: { draft: DraftDetail }) {
  const { can } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const setLines = useSetDraftLines(draft.id)
  const update = useUpdateDraft(draft.id)
  const place = usePlaceDraft(draft.id)
  const discard = useDiscardDraft()
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false)

  const canWrite = can('orders:write')
  // A placed draft is a record, not a document. It is shown, never edited —
  // the order it became is the thing that can still be changed.
  const readOnly = !canWrite || draft.placedOrderId !== null
  const isSaving = setLines.isPending || update.isPending
  const state = draftState(draft)

  function fail(title: string) {
    return (error: unknown) =>
      toast({ tone: 'error', title, description: messageOf(error) })
  }

  function saveLines(lines: DraftLineInput[]) {
    setLines.mutate(lines, { onError: fail('Could not save the lines') })
  }

  function savePatch(patch: DraftPatch) {
    update.mutate(patch, { onError: fail('Could not save that') })
  }

  function placeOrder() {
    place.mutate(undefined, {
      onSuccess: (order) => {
        toast({
          tone: 'success',
          title: `Order ${order.orderNumber} placed`,
          description: 'Stock is reserved and the confirmation is on its way.',
        })
        void navigate(`/orders/${order.id}`)
      },
      onError: fail('Could not place the order'),
    })
  }

  function discardDraft() {
    discard.mutate(draft.id, {
      onSuccess: () => {
        toast({ tone: 'success', title: 'Draft discarded' })
        void navigate('/drafts')
      },
      onError: fail('Could not discard it'),
    })
  }

  return (
    <>
      <PageHeader
        title={draftTitle(draft)}
        description={
          draft.placedOrderId
            ? 'Placed. Kept as the record of what was quoted.'
            : 'Nothing is reserved until this is placed.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone}>{state.label}</Badge>
            {readOnly ? null : (
              <Button
                variant="ghost"
                leadingIcon={<Trash2 className="size-4" />}
                onClick={() => setIsConfirmingDiscard(true)}
              >
                Discard
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <DraftLinesCard
            draft={draft}
            onChange={saveLines}
            isSaving={isSaving}
            readOnly={readOnly}
          />
          <DraftDetailsCard
            // Keyed on the draft, not on `updatedAt`: adding a line bumps the
            // timestamp, and remounting on that would wipe an address someone
            // is halfway through typing while they add another item.
            key={draft.id}
            draft={draft}
            onSave={savePatch}
            isSaving={update.isPending}
            readOnly={readOnly}
          />
        </div>

        <DraftSummaryCard
          draft={draft}
          onSave={savePatch}
          onPlace={placeOrder}
          isSaving={isSaving}
          isPlacing={place.isPending}
          canPlace={canWrite}
        />
      </div>

      <ConfirmDialog
        isOpen={isConfirmingDiscard}
        onCancel={() => setIsConfirmingDiscard(false)}
        onConfirm={discardDraft}
        tone="danger"
        title="Discard this draft?"
        confirmLabel="Discard"
        isLoading={discard.isPending}
      >
        Nothing was reserved, so nothing is released — but the quote and its lines are gone for
        good.
      </ConfirmDialog>
    </>
  )
}
