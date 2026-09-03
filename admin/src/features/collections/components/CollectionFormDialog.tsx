import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useCreateCollection } from '../hooks/collections.hooks'
import type { CollectionType } from '../types/collections.types'

export interface CollectionFormDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated?: (collectionId: string) => void
}

/**
 * Creating a collection.
 *
 * The kind is chosen here and only here, because it decides what the rest of
 * the editing looks like — a hand-picked list or a rule — and switching later
 * throws work away: turning a manual collection smart drops the products
 * somebody chose, since from that moment the rules are the membership. Saying
 * so at the point of choice is cheaper than a confirmation dialog later.
 *
 * The rules themselves are written on the collection's own page, where there is
 * room for the builder and the live preview beside it.
 */
export function CollectionFormDialog({ isOpen, onClose, onCreated }: CollectionFormDialogProps) {
  const { toast } = useToast()
  const create = useCreateCollection()

  const [title, setTitle] = useState('')
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<CollectionType>('manual')

  function reset() {
    setTitle('')
    setHandle('')
    setDescription('')
    setType('manual')
  }

  function submit() {
    if (create.isPending || title.trim() === '') return

    create.mutate(
      {
        title: title.trim(),
        type,
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      {
        onSuccess: (collection) => {
          toast({ tone: 'success', title: 'Collection created' })
          reset()
          onClose()
          onCreated?.(collection.id)
        },
        onError: (error) =>
          toast({
            tone: 'error',
            title: 'Could not create the collection',
            description: messageOf(error),
          }),
      },
    )
  }

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="New collection"
      description="A place products appear together on the storefront."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={title.trim() === ''} isLoading={create.isPending} onClick={submit}>
            Create collection
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field
          label="Handle"
          hint="Its address on the storefront. Left blank, it follows the title."
        >
          <Input
            value={handle}
            placeholder="best-sellers"
            onChange={(event) => setHandle(event.target.value)}
          />
        </Field>

        <Field label="Description">
          <RichTextEditor
            value={description}
            aria-label="Description"
            minHeight="9rem"
            onChange={setDescription}
          />
        </Field>

        <Field label="How products get in">
          <Select
            value={type}
            onChange={(event) => setType(event.target.value as CollectionType)}
            options={[
              { value: 'manual', label: 'I choose them — a list I arrange' },
              { value: 'dynamic', label: 'A rule finds them — smart collection' },
            ]}
          />
        </Field>

        {type === 'dynamic' ? (
          <Alert tone="info" title="Membership is the rule">
            A smart collection has no hand-picked products: it holds whatever matches at the moment
            somebody looks, so it stops containing something the instant that stops being true. You
            will write the rules on the next screen.
          </Alert>
        ) : null}
      </div>
    </Drawer>
  )
}
