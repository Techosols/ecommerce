import { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { TagsInput } from '@/components/ui/TagsInput'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useFormState } from '@/lib/useFormState'
import { useAnnotateOrder } from '../hooks/orders.hooks'
import type { OrderDetail } from '../types/orders.types'

interface AnnotationValues extends Record<string, unknown> {
  note: string
  tags: string[]
}

function toValues(order: OrderDetail): AnnotationValues {
  return { note: order.adminNote ?? '', tags: order.tags }
}

export interface OrderAnnotationsCardProps {
  order: OrderDetail
  canWrite: boolean
}

/**
 * The pinned note and the tags.
 *
 * Distinct from the timeline's notes, and the distinction is the point: this is
 * the one sentence whoever opens the order next should read first ("leave with
 * the neighbour"), and it is meant to be overwritten. The timeline is the
 * running record, and nothing there is ever rewritten.
 *
 * Both save in one request because they are one edit; two requests would leave
 * the tags saved and the note lost when the second failed.
 */
export function OrderAnnotationsCard({ order, canWrite }: OrderAnnotationsCardProps) {
  const { toast } = useToast()
  const annotate = useAnnotateOrder(order.id)

  const form = useFormState<AnnotationValues>(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useMemo(() => toValues(order), []),
  )

  // Re-baseline when the order is refetched, but never over an unsaved edit: a
  // background refetch must not wipe what somebody is halfway through typing.
  useEffect(() => {
    if (!form.isDirty) form.reset(toValues(order))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.updatedAt, order.id])

  function save() {
    if (annotate.isPending || !form.isDirty) return
    annotate.mutate(
      {
        note: form.values.note.trim() === '' ? null : form.values.note.trim(),
        tags: form.values.tags,
      },
      {
        onSuccess: (saved) => {
          form.reset(toValues(saved))
          toast({ tone: 'success', title: 'Saved' })
        },
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not save', description: messageOf(error) }),
      },
    )
  }

  return (
    <Card>
      <CardHeader title="Notes and tags" description="Staff-only. The customer never sees these." />
      <CardBody className="flex flex-col gap-4">
        <Field label="Note" hint="One instruction, overwritten as it changes.">
          <Textarea
            rows={3}
            value={form.values.note}
            maxLength={2000}
            disabled={!canWrite || annotate.isPending}
            placeholder="Leave with the neighbour at number 12."
            onChange={(event) => form.setValue('note', event.target.value)}
          />
        </Field>

        <Field label="Tags" hint="For finding this order again later.">
          <TagsInput
            value={form.values.tags}
            maxTags={50}
            maxLength={40}
            disabled={!canWrite || annotate.isPending}
            placeholder="fragile, chase…"
            onChange={(tags) => form.setValue('tags', tags)}
          />
        </Field>

        {canWrite ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={!form.isDirty}
              isLoading={annotate.isPending}
              onClick={save}
            >
              {form.isDirty ? 'Save' : 'Saved'}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
