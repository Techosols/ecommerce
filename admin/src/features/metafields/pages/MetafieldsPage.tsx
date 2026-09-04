import { useState } from 'react'
import { Eye, EyeOff, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import {
  useCreateDefinition,
  useDefinitions,
  useDeleteDefinition,
  useUpdateDefinition,
} from '../hooks/metafields.hooks'
import {
  METAFIELD_TYPES,
  OWNER_LABELS,
  OWNER_TYPES,
  TYPE_LABELS,
  type MetafieldDefinition,
  type MetafieldOwnerType,
  type MetafieldType,
} from '../types/metafields.types'

/**
 * The fields this shop has added to its own records.
 *
 * ── Why defining lives here and filling in lives elsewhere ───────────────────
 *
 * What fields exist is store configuration — it changes rarely, it changes the
 * shape of every record of that kind, and it belongs beside the rest of the
 * store's setup. Typing a value into one is editing a product, and happens on
 * the product. The server draws the same line with two different permissions.
 *
 * ── What cannot be changed after the fact ────────────────────────────────────
 *
 * A field's type, namespace and key are fixed once it exists, because values
 * are already stored against them: changing a text field to a number would not
 * convert anything, it would leave every stored value invalid under its own
 * definition. The label can be renamed freely, which is what people usually
 * mean. The form says so rather than letting somebody find out.
 */
export function MetafieldsPage() {
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Custom fields')

  const [ownerType, setOwnerType] = useState<MetafieldOwnerType>('product')
  const definitions = useDefinitions(ownerType)
  const deleteDefinition = useDeleteDefinition()

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<MetafieldDefinition | null>(null)
  const [deleting, setDeleting] = useState<MetafieldDefinition | null>(null)

  const canWrite = can('settings:write')

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Custom fields"
        description="Extra fields on your products, collections, customers and orders."
        actions={
          canWrite ? (
            <Button leadingIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Add a field
            </Button>
          ) : undefined
        }
      />

      <div className="border-line flex gap-1 overflow-x-auto border-b" role="tablist">
        {OWNER_TYPES.map((type) => (
          <button
            key={type}
            role="tab"
            aria-selected={ownerType === type}
            onClick={() => setOwnerType(type)}
            className={
              ownerType === type
                ? 'border-brand-600 text-brand-700 dark:text-brand-300 -mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap'
                : 'text-muted hover:text-ink -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap'
            }
          >
            {OWNER_LABELS[type]}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader
          title={`Fields on ${OWNER_LABELS[ownerType].toLowerCase()}`}
          description="Staff see every field. Customers see only the ones marked visible."
        />
        <CardBody>
          <QueryBoundary
            isLoading={definitions.isPending}
            error={definitions.error}
            onRetry={() => void definitions.refetch()}
          >
            {definitions.data && definitions.data.length > 0 ? (
              <ul className="divide-line border-line divide-y rounded-lg border">
                {definitions.data.map((definition) => (
                  <li key={definition.id} className="flex flex-wrap items-start gap-3 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink font-medium">{definition.name}</span>
                        <Badge size="sm" tone="neutral">
                          {TYPE_LABELS[definition.type]}
                        </Badge>
                        {definition.required ? (
                          <Badge size="sm" tone="warning">
                            Required
                          </Badge>
                        ) : null}
                        {definition.storefrontVisible ? (
                          <Badge size="sm" tone="positive">
                            <Eye className="mr-1 inline size-3" />
                            Customers can see this
                          </Badge>
                        ) : (
                          <Badge size="sm" tone="neutral">
                            <EyeOff className="mr-1 inline size-3" />
                            Staff only
                          </Badge>
                        )}
                      </div>
                      <span className="text-faint block font-mono text-xs">
                        {definition.namespace}.{definition.key}
                      </span>
                      {definition.description ? (
                        <span className="text-muted mt-1 block text-xs">
                          {definition.description}
                        </span>
                      ) : null}
                    </div>

                    <span className="text-muted text-xs tabular-nums">
                      {definition.valueCount === 0
                        ? 'Not used yet'
                        : `${definition.valueCount} filled in`}
                    </span>

                    {canWrite ? (
                      <div className="flex gap-1">
                        <Button size="xs" variant="ghost" onClick={() => setEditing(definition)}>
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Delete ${definition.name}`}
                          onClick={() => setDeleting(definition)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<SlidersHorizontal className="size-6" />}
                title={`No custom fields on ${OWNER_LABELS[ownerType].toLowerCase()} yet`}
                description="Add one to record something this shop cares about that the built-in fields do not cover — ingredients, shelf life, a supplier code."
                actions={
                  canWrite ? (
                    <Button onClick={() => setCreating(true)}>Add the first field</Button>
                  ) : undefined
                }
              />
            )}
          </QueryBoundary>
        </CardBody>
      </Card>

      {creating ? (
        <DefinitionDialog
          ownerType={ownerType}
          definition={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <DefinitionDialog
          ownerType={editing.ownerType}
          definition={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={deleting !== null}
        onCancel={() => setDeleting(null)}
        title="Delete this field?"
        confirmLabel="Delete the field"
        tone="danger"
        isLoading={deleteDefinition.isPending}
        onConfirm={() =>
          void (async () => {
            if (!deleting) return
            try {
              const result = await deleteDefinition.mutateAsync(deleting.id)
              toast({
                tone: 'success',
                title: 'Field deleted',
                description:
                  result.deletedValues === 0
                    ? 'It had no values.'
                    : `${result.deletedValues} values were deleted with it.`,
              })
              setDeleting(null)
            } catch (error) {
              toast({ tone: 'error', title: messageOf(error) })
            }
          })()
        }
      >
        {deleting ? (
          /* The count is the whole point of this dialog. "Are you sure?" tells
             an operator nothing; "this will delete 340 values" is the decision
             they are actually being asked to make. */
          <>
            <strong>{deleting.name}</strong> will be removed from every{' '}
            {OWNER_LABELS[deleting.ownerType].toLowerCase().replace(/s$/, '')}, along with{' '}
            {deleting.valueCount === 0
              ? 'no stored values'
              : `the ${deleting.valueCount} values already filled in`}
            . This cannot be undone.
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

function DefinitionDialog({
  ownerType,
  definition,
  onClose,
}: {
  ownerType: MetafieldOwnerType
  definition: MetafieldDefinition | null
  onClose: () => void
}) {
  const { toast } = useToast()
  const create = useCreateDefinition()
  const update = useUpdateDefinition()
  const isEdit = definition !== null

  const [name, setName] = useState(definition?.name ?? '')
  const [namespace, setNamespace] = useState(definition?.namespace ?? 'custom')
  const [key, setKey] = useState(definition?.key ?? '')
  const [description, setDescription] = useState(definition?.description ?? '')
  const [type, setType] = useState<MetafieldType>(definition?.type ?? 'single_line_text')
  const [required, setRequired] = useState(definition?.required ?? false)
  const [storefrontVisible, setStorefrontVisible] = useState(
    definition?.storefrontVisible ?? false,
  )
  const [choices, setChoices] = useState((definition?.validations.choices ?? []).join('\n'))
  const [error, setError] = useState<string | null>(null)

  /**
   * The key is suggested from the name and then left alone.
   *
   * Suggested, because nobody wants to type "how_to_use" after typing "How to
   * use". Left alone once the field exists, because it is the identity a
   * storefront template refers to — renaming the label must not silently break
   * a page.
   */
  function onNameChange(value: string) {
    setName(value)
    if (!isEdit) {
      setKey(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 64),
      )
    }
  }

  const supportsChoices = type === 'single_line_text'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    const parsedChoices = choices
      .split('\n')
      .map((choice) => choice.trim())
      .filter(Boolean)
    const validations = supportsChoices && parsedChoices.length > 0 ? { choices: parsedChoices } : {}

    try {
      if (isEdit) {
        await update.mutateAsync({
          id: definition.id,
          patch: {
            name: name.trim(),
            description: description.trim() || null,
            validations,
            required,
            storefrontVisible,
          },
        })
      } else {
        await create.mutateAsync({
          ownerType,
          namespace: namespace.trim(),
          key: key.trim(),
          name: name.trim(),
          description: description.trim() || null,
          type,
          validations,
          required,
          storefrontVisible,
        })
      }
      toast({ tone: 'success', title: isEdit ? 'Field updated' : 'Field added' })
      onClose()
    } catch (caught) {
      setError(messageOf(caught))
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEdit ? `Edit ${definition.name}` : `Add a field to ${OWNER_LABELS[ownerType]}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="What staff will see beside the input.">
          <Input value={name} onChange={(event) => onNameChange(event.target.value)} required />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Namespace">
            <Input
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              disabled={isEdit}
              required
            />
          </Field>
          <Field
            label="Key"
            hint={isEdit ? 'Fixed once the field exists.' : 'How a storefront refers to it.'}
          >
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={isEdit}
              required
            />
          </Field>
        </div>

        <Field
          label="Type"
          hint={
            isEdit
              ? 'The type cannot change: values are already stored against it.'
              : 'What this field will accept. The server checks every value against it.'
          }
        >
          <Select
            value={type}
            onChange={(event) => setType(event.target.value as MetafieldType)}
            disabled={isEdit}
          >
            {METAFIELD_TYPES.map((option) => (
              <option key={option} value={option}>
                {TYPE_LABELS[option]}
              </option>
            ))}
          </Select>
        </Field>

        {supportsChoices ? (
          <Field
            label="Allowed values"
            hint="One per line. Leave empty to accept any text; fill it in to get a dropdown."
          >
            <Textarea
              value={choices}
              onChange={(event) => setChoices(event.target.value)}
              rows={3}
            />
          </Field>
        ) : null}

        <Field label="Help text" hint="Shown under the input. Optional.">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>

        <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-ink text-sm font-medium">Customers can see this</p>
            <p className="text-muted mt-0.5 text-xs">
              Off by default. When on, the field is included in the public product or collection
              API — so leave it off for anything internal, like a supplier code.
            </p>
          </div>
          <Switch
            checked={storefrontVisible}
            label="Customers can see this"
            onCheckedChange={setStorefrontVisible}
          />
        </div>

        <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-ink text-sm font-medium">Required</p>
            <p className="text-muted mt-0.5 text-xs">
              Stops the field being cleared once it has a value. It does not block saving a record
              that never had one.
            </p>
          </div>
          <Switch checked={required} label="Required" onCheckedChange={setRequired} />
        </div>

        {error ? (
          <Alert tone="danger" title="That field was not saved">
            {error}
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={create.isPending || update.isPending}>
            {isEdit ? 'Save changes' : 'Add field'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
