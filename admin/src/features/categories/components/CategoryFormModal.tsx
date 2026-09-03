import { useState, type FormEvent } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { RichTextEditor } from '@/components/editor/RichTextEditor'
import { useToast } from '@/components/ui/toast.context'
import { slugify, useFormState } from '@/lib/useFormState'
import {
  useCategoryTree,
  useCreateCategory,
  useUpdateCategory,
  descendantIds,
} from '../hooks/categories.hooks'
import type { Category } from '../types/categories.types'

interface CategoryFormValues extends Record<string, unknown> {
  name: string
  handle: string
  parentId: string
  description: string
  position: number
  isActive: boolean
}

export interface CategoryFormModalProps {
  isOpen: boolean
  onClose: () => void
  /** `null` creates; a category edits it. */
  category: Category | null
  /** Pre-selected parent when creating a child from a row action. */
  defaultParentId?: string | null
}

/**
 * Mounts the dialog only while it is open, keyed by what it is editing.
 *
 * The key is what makes the form start from the right values every time it
 * opens: React discards the previous instance and its state rather than the
 * form having to notice, in an effect, that it is now looking at a different
 * category. One less thing to get wrong, and no frame where the previous
 * category's name is on screen.
 */
export function CategoryFormModal({
  isOpen,
  onClose,
  category,
  defaultParentId,
}: CategoryFormModalProps) {
  if (!isOpen) return null

  return (
    <CategoryFormDialog
      key={category ? `edit:${category.id}` : `new:${defaultParentId ?? 'root'}`}
      onClose={onClose}
      category={category}
      defaultParentId={defaultParentId ?? null}
    />
  )
}

function toValues(category: Category | null, defaultParentId?: string | null): CategoryFormValues {
  return {
    name: category?.name ?? '',
    handle: category?.handle ?? '',
    parentId: category?.parentId ?? defaultParentId ?? '',
    description: category?.description ?? '',
    position: category?.position ?? 0,
    isActive: category?.isActive ?? true,
  }
}

/**
 * Create and edit, in one dialog.
 *
 * The two differ by which endpoint they call and by `isActive`, which only
 * `updateCategorySchema` accepts — a category is created active, and switching
 * it off is a later decision. Everything else is identical, and two components
 * would drift.
 *
 * The parent picker excludes the category itself and its whole subtree. The
 * server refuses such a move with `CATEGORY_CYCLE`; leaving the options out
 * means an operator never reaches that error.
 */
function CategoryFormDialog({
  onClose,
  category,
  defaultParentId,
}: {
  onClose: () => void
  category: Category | null
  defaultParentId: string | null
}) {
  const { toast } = useToast()
  const { tree, flat } = useCategoryTree()
  const create = useCreateCategory()
  const update = useUpdateCategory()

  const isEditing = category !== null
  const mutation = isEditing ? update : create
  const form = useFormState<CategoryFormValues>(toValues(category, defaultParentId))
  const [handleTouched, setHandleTouched] = useState(false)

  const blocked = isEditing ? descendantIds(tree, category.id) : new Set<string>()

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return

    const name = form.values.name.trim()
    if (!name) {
      form.setErrors({ name: 'A category needs a name.' })
      return
    }
    if (form.values.handle && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.values.handle)) {
      form.setErrors({ handle: 'Lowercase letters, digits and single hyphens only.' })
      return
    }

    try {
      if (isEditing) {
        // Only what changed, so an untouched field is absent from the PATCH.
        const dirty = form.dirty
        const patch: Record<string, unknown> = {}
        if (dirty.name !== undefined) patch.name = name
        if (dirty.handle !== undefined) patch.handle = form.values.handle.trim()
        if (dirty.parentId !== undefined) patch.parentId = form.values.parentId || null
        if (dirty.description !== undefined) {
          patch.description = form.values.description.trim() || null
        }
        if (dirty.position !== undefined) patch.position = form.values.position
        if (dirty.isActive !== undefined) patch.isActive = form.values.isActive

        if (Object.keys(patch).length === 0) {
          onClose()
          return
        }
        await update.mutateAsync({ id: category.id, patch })
        toast({ tone: 'success', title: `${name} updated` })
      } else {
        await create.mutateAsync({
          name,
          ...(form.values.handle.trim() ? { handle: form.values.handle.trim() } : {}),
          ...(form.values.parentId ? { parentId: form.values.parentId } : {}),
          ...(form.values.description.trim()
            ? { description: form.values.description.trim() }
            : {}),
          ...(form.values.position ? { position: form.values.position } : {}),
        })
        toast({ tone: 'success', title: `${name} created` })
      }
      onClose()
    } catch (error) {
      form.applyServerError(
        error,
        isEditing ? 'The category could not be saved.' : 'The category could not be created.',
      )
    }
  }

  return (
    <Modal
      isOpen
      onClose={mutation.isPending ? () => undefined : onClose}
      dismissible={!mutation.isPending}
      title={isEditing ? `Edit ${category.name}` : 'New category'}
      description={
        isEditing
          ? 'Renaming is safe — products stay where they are.'
          : 'Categories form a tree. Leave the parent empty for a top-level category.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="category-form"
            variant="primary"
            isLoading={mutation.isPending}
          >
            {isEditing ? 'Save changes' : 'Create category'}
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        {form.formError ? <Alert tone="danger">{form.formError}</Alert> : null}

        <Field label="Name" error={form.errors.name} required>
          <Input
            value={form.values.name}
            maxLength={120}
            data-autofocus
            disabled={mutation.isPending}
            placeholder="Outerwear"
            onChange={(event) => {
              form.setValue('name', event.target.value)
              if (!handleTouched && !isEditing) form.setValue('handle', slugify(event.target.value))
            }}
          />
        </Field>

        <Field
          label="Handle"
          error={form.errors.handle}
          hint="The URL segment. Left blank on create, the server derives one."
        >
          <Input
            value={form.values.handle}
            maxLength={120}
            disabled={mutation.isPending}
            placeholder="outerwear"
            onChange={(event) => {
              setHandleTouched(true)
              form.setValue('handle', event.target.value)
            }}
          />
        </Field>

        <Field label="Parent" error={form.errors.parentId}>
          <Select
            value={form.values.parentId}
            disabled={mutation.isPending}
            onChange={(event) => form.setValue('parentId', event.target.value)}
            options={[
              { value: '', label: 'Top level' },
              ...flat
                .filter((node) => !blocked.has(node.id))
                .map((node) => ({
                  value: node.id,
                  label: `${'  '.repeat(node.depth)}${node.name}`,
                })),
            ]}
          />
        </Field>

        <Field label="Description" error={form.errors.description}>
          <RichTextEditor
            value={form.values.description}
            disabled={mutation.isPending}
            aria-label="Description"
            minHeight="9rem"
            onChange={(html) => form.setValue('description', html)}
          />
        </Field>

        <Field
          label="Position"
          error={form.errors.position}
          hint="Lower numbers sort first among siblings."
        >
          <Input
            type="number"
            min={0}
            max={10_000}
            value={String(form.values.position)}
            disabled={mutation.isPending}
            onChange={(event) => form.setValue('position', Number(event.target.value) || 0)}
            className="w-32"
          />
        </Field>

        {isEditing ? (
          <div className="border-line flex items-start justify-between gap-4 border-t pt-4">
            <div>
              <p className="text-ink text-sm font-medium">Visible on the storefront</p>
              <p className="text-muted mt-0.5 text-xs">
                Switching this off hides the category without archiving it. Its products stay where
                they are.
              </p>
            </div>
            <Switch
              checked={form.values.isActive}
              disabled={mutation.isPending}
              label="Visible on the storefront"
              onCheckedChange={(checked) => form.setValue('isActive', checked)}
            />
          </div>
        ) : null}
      </form>
    </Modal>
  )
}
