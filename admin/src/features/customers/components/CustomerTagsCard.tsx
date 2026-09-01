import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { TagsInput } from '@/components/ui/TagsInput'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useCustomerTags } from '../hooks/customers.hooks'

export interface CustomerTagsCardProps {
  customerId: string
  tags: string[]
  canWrite: boolean
}

/**
 * Tags, edited as a list and saved as a difference.
 *
 * The API adds and removes rather than replacing, which is right — two people
 * tagging the same customer at once should not silently undo each other — so
 * this card works out what changed and sends only that. Comparison is
 * case-insensitive because the server de-dupes that way; typing "VIP" over
 * "vip" is not a change.
 */
export function CustomerTagsCard({ customerId, tags, canWrite }: CustomerTagsCardProps) {
  const { toast } = useToast()
  const mutate = useCustomerTags(customerId)
  const [baseline, setBaseline] = useState<string[]>(tags)
  const [draft, setDraft] = useState<string[]>(tags)

  const isDirty = !sameTags(draft, baseline)

  // Re-baselined during render rather than in an effect: React's own pattern
  // for state derived from a prop that changes underneath it. An unsaved edit
  // survives a background refetch; anything else takes the new value.
  if (!sameTags(baseline, tags)) {
    setBaseline(tags)
    if (!isDirty) setDraft(tags)
  }

  function save() {
    if (mutate.isPending || !isDirty) return

    const lower = (list: string[]) => new Set(list.map((tag) => tag.toLowerCase()))
    const before = lower(tags)
    const after = lower(draft)

    const added = draft.filter((tag) => !before.has(tag.toLowerCase()))
    const removed = tags.filter((tag) => !after.has(tag.toLowerCase()))

    const run = async () => {
      // Removals first: adding then removing would briefly show a tag the
      // operator has just taken off.
      if (removed.length > 0) await mutate.mutateAsync({ tags: removed, action: 'remove' })
      if (added.length > 0) await mutate.mutateAsync({ tags: added, action: 'add' })
    }

    run().then(
      () => toast({ tone: 'success', title: 'Tags updated' }),
      (error: unknown) =>
        toast({ tone: 'error', title: 'Could not update the tags', description: messageOf(error) }),
    )
  }

  return (
    <Card>
      <CardHeader title="Tags" description="Free labels the customer list can filter on." />

      <CardBody className="flex flex-col gap-3">
        {canWrite ? (
          <>
            <TagsInput
              value={draft}
              onChange={setDraft}
              disabled={mutate.isPending}
              placeholder="wholesale, vip…"
            />
            {isDirty ? (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDraft(tags)}>
                  Cancel
                </Button>
                <Button size="sm" isLoading={mutate.isPending} onClick={save}>
                  Save tags
                </Button>
              </div>
            ) : null}
          </>
        ) : tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} size="sm">
                {tag}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted text-sm">No tags.</p>
        )}
      </CardBody>
    </Card>
  )
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((tag, index) => tag.toLowerCase() === (b[index] ?? '').toLowerCase())
}
