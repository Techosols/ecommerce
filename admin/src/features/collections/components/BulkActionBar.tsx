import { useState } from 'react'
import { X } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { TagsInput } from '@/components/ui/TagsInput'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useBulkProductAction, useCollections } from '../hooks/collections.hooks'
import type { BulkAction } from '../types/collections.types'

export interface BulkActionBarProps {
  productIds: string[]
  onClear: () => void
}

const ACTIONS: Array<{ value: BulkAction | ''; label: string }> = [
  { value: '', label: 'Choose an action…' },
  { value: 'setStatus', label: 'Change status' },
  { value: 'publish', label: 'Publish' },
  { value: 'unpublish', label: 'Unpublish' },
  { value: 'addToCollection', label: 'Add to collection' },
  { value: 'removeFromCollection', label: 'Remove from collection' },
  { value: 'addTags', label: 'Add tags' },
  { value: 'removeTags', label: 'Remove tags' },
]

/**
 * One change across a selection.
 *
 * The server runs the same single-product operations one at a time and reports
 * on each, so a draft product refusing to publish does not sink the other
 * thirty-nine. This bar's job is to show that honestly: a partial result says
 * how many failed and why, rather than a green tick that was true for most of
 * them.
 *
 * Smart collections are absent from the collection picker on purpose — their
 * membership is their rules, and the server refuses to be told otherwise.
 */
export function BulkActionBar({ productIds, onClear }: BulkActionBarProps) {
  const { toast } = useToast()
  const bulk = useBulkProductAction()
  const collections = useCollections()

  const [action, setAction] = useState<BulkAction | ''>('')
  const [status, setStatus] = useState<'draft' | 'active' | 'archived'>('active')
  const [collectionId, setCollectionId] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [failures, setFailures] = useState<string[]>([])

  const manualCollections = (collections.data ?? []).filter(
    (collection) => collection.type === 'manual',
  )

  const needsCollection = action === 'addToCollection' || action === 'removeFromCollection'
  const needsTags = action === 'addTags' || action === 'removeTags'
  const ready =
    action !== '' &&
    (!needsCollection || collectionId !== '') &&
    (!needsTags || tags.length > 0)

  function run() {
    if (!ready || bulk.isPending) return
    setFailures([])

    bulk.mutate(
      {
        productIds,
        action,
        ...(action === 'setStatus' ? { status } : {}),
        ...(needsCollection ? { collectionId } : {}),
        ...(needsTags ? { tags } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.failed === 0) {
            toast({
              tone: 'success',
              title: `${result.succeeded} ${result.succeeded === 1 ? 'product' : 'products'} updated`,
            })
            onClear()
            return
          }
          // Partial: the selection stays, so the operator can see what is left
          // and act on it rather than reconstructing it from memory.
          setFailures(
            result.results
              .filter((entry) => !entry.ok)
              .map((entry) => entry.error ?? 'Failed')
              .filter((message, index, all) => all.indexOf(message) === index),
          )
          toast({
            tone: 'warning',
            title: `${result.succeeded} updated, ${result.failed} could not be`,
          })
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not run that', description: messageOf(error) }),
      },
    )
  }

  return (
    <div className="border-line bg-surface-subtle flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink text-sm font-medium">
          {productIds.length} selected
        </span>

        <Select
          size="sm"
          aria-label="Bulk action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value as BulkAction | '')
            setFailures([])
          }}
          options={ACTIONS}
        />

        {action === 'setStatus' ? (
          <Select
            size="sm"
            aria-label="New status"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as 'draft' | 'active' | 'archived')
            }
            options={[
              { value: 'active', label: 'Active' },
              { value: 'draft', label: 'Draft' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        ) : null}

        {needsCollection ? (
          <Select
            size="sm"
            aria-label="Collection"
            value={collectionId}
            placeholder="Choose a collection…"
            onChange={(event) => setCollectionId(event.target.value)}
            options={manualCollections.map((collection) => ({
              value: collection.id,
              label: collection.title,
            }))}
          />
        ) : null}

        {needsTags ? (
          <div className="min-w-52 flex-1">
            <TagsInput value={tags} onChange={setTags} placeholder="Tags…" />
          </div>
        ) : null}

        <Button size="sm" disabled={!ready} isLoading={bulk.isPending} onClick={run}>
          Apply
        </Button>

        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<X className="size-3.5" />}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>

      {failures.length > 0 ? (
        <Alert tone="warning" title="Some products did not change">
          {failures.join(' · ')}
        </Alert>
      ) : null}
    </div>
  )
}
