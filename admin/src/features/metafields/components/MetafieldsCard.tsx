import { useEffect, useState } from 'react'
import { Eye } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api/errors'
import { useMetafieldValues, useSetMetafieldValues } from '../hooks/metafields.hooks'
import type { MetafieldEntry, MetafieldOwnerType } from '../types/metafields.types'

export interface MetafieldsCardProps {
  ownerType: MetafieldOwnerType
  ownerId: string
  /** The permission on the *record*, which is what the server checks. */
  canWrite: boolean
  title?: string
}

/**
 * The custom fields on one record.
 *
 * ── Why one component for five kinds of record ───────────────────────────────
 *
 * Because the form is generated from the definitions, not written per page.
 * The server says a product has an "Ingredients" long-text field and a
 * "Shelf life" whole-number field; this renders a textarea and a number input.
 * Adding a field is then an insert, and every page that shows this card gains
 * it at once — which is the entire promise of metafields, and would be lost the
 * moment somebody hand-wrote the product version.
 *
 * ── Why it saves on its own ──────────────────────────────────────────────────
 *
 * The record's own form and this card write to different endpoints, and the
 * server applies these as one transaction of its own. Sharing a save button
 * would mean either two requests pretending to be one — with a real state where
 * the product saved and its fields did not — or rebuilding the product form
 * around an endpoint that does not exist. A separate save is honest about what
 * is actually one operation.
 *
 * ── Why it renders nothing when no fields are defined ────────────────────────
 *
 * An empty card on every product page, forever, for a shop that never defines a
 * field, is clutter with a permanent cost. There is a pointer to where fields
 * are created instead, and only for the people who could act on it.
 */
export function MetafieldsCard({ ownerType, ownerId, canWrite, title }: MetafieldsCardProps) {
  const { toast } = useToast()
  const query = useMetafieldValues(ownerType, ownerId)
  const save = useSetMetafieldValues(ownerType, ownerId)

  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * The server's values are the starting point, and they replace the draft
   * whenever they change — including after a save, which returns the stored
   * state. Keying on `updatedAt` rather than the array identity avoids
   * clobbering what somebody is halfway through typing on an unrelated refetch.
   */
  const signature = query.data?.map((entry) => `${entry.definitionId}:${entry.updatedAt}`).join('|')
  useEffect(() => {
    if (!query.data) return
    setDraft(Object.fromEntries(query.data.map((entry) => [entry.definitionId, entry.value])))
    setDirty(false)
  }, [signature, query.data])

  if (query.isSuccess && query.data.length === 0) return null

  function update(definitionId: string, value: unknown) {
    setDraft((current) => ({ ...current, [definitionId]: value }))
    setDirty(true)
    setError(null)
  }

  async function submit() {
    setError(null)
    try {
      await save.mutateAsync(
        Object.entries(draft).map(([definitionId, value]) => ({ definitionId, value })),
      )
      toast({ tone: 'success', title: 'Custom fields saved' })
      setDirty(false)
    } catch (caught) {
      // The server's own sentence — "Shelf life must be a whole number" — which
      // names the field and what is wrong with it.
      setError(messageOf(caught))
    }
  }

  return (
    <Card>
      <CardHeader
        title={title ?? 'Custom fields'}
        description="Extra information this shop records."
        actions={
          canWrite && dirty ? (
            <Button size="sm" isLoading={save.isPending} onClick={() => void submit()}>
              Save fields
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <QueryBoundary
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
        >
          <div className="flex flex-col gap-4">
            {(query.data ?? []).map((entry) => (
              <MetafieldInput
                key={entry.definitionId}
                entry={entry}
                value={draft[entry.definitionId]}
                disabled={!canWrite}
                onChange={(value) => update(entry.definitionId, value)}
              />
            ))}

            {error ? (
              <Alert tone="danger" title="Those fields were not saved">
                {error}
              </Alert>
            ) : null}
          </div>
        </QueryBoundary>
      </CardBody>
    </Card>
  )
}

/**
 * One field, rendered as whatever its type calls for.
 *
 * Everything is kept as a string in the draft except booleans, and sent as a
 * string to the server, which coerces it against the definition. That is
 * deliberate: a number input that parsed as you typed would turn "1." into 1
 * and eat the decimal point, and the server has to re-check the value anyway.
 */
function MetafieldInput({
  entry,
  value,
  disabled,
  onChange,
}: {
  entry: MetafieldEntry
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const label = (
    <span className="inline-flex items-center gap-1.5">
      {entry.name}
      {entry.storefrontVisible ? (
        <Tooltip label="Customers can see this field">
          <Eye className="text-muted size-3.5" aria-label="Customers can see this field" />
        </Tooltip>
      ) : null}
    </span>
  )

  const hint = entry.description ?? undefined
  const asText = value === null || value === undefined ? '' : String(value)

  if (entry.type === 'boolean') {
    return (
      <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
        <div>
          <p className="text-ink text-sm font-medium">{label}</p>
          {hint ? <p className="text-muted mt-0.5 text-xs">{hint}</p> : null}
        </div>
        <Switch
          checked={value === true}
          disabled={disabled}
          label={entry.name}
          onCheckedChange={onChange}
        />
      </div>
    )
  }

  if (entry.validations.choices?.length) {
    return (
      <Field label={label} hint={hint} required={entry.required}>
        <Select
          value={asText}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        >
          {/* An optional field needs a way back to "not set"; a required one
              must not offer one. */}
          {entry.required ? null : <option value="">—</option>}
          {entry.validations.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  if (entry.type === 'multi_line_text' || entry.type === 'json') {
    return (
      <Field
        label={label}
        hint={entry.type === 'json' ? (hint ?? 'JSON. The server checks it parses.') : hint}
        required={entry.required}
      >
        <Textarea
          value={entry.type === 'json' ? formatJson(value) : asText}
          disabled={disabled}
          rows={entry.type === 'json' ? 4 : 3}
          className={entry.type === 'json' ? 'font-mono text-xs' : undefined}
          onChange={(event) => onChange(event.target.value || null)}
        />
      </Field>
    )
  }

  const inputType =
    entry.type === 'integer' || entry.type === 'decimal'
      ? 'number'
      : entry.type === 'date'
        ? 'date'
        : entry.type === 'url'
          ? 'url'
          : 'text'

  return (
    <Field label={label} hint={hint} required={entry.required}>
      <Input
        type={inputType}
        value={asText}
        disabled={disabled}
        step={entry.type === 'decimal' ? 'any' : entry.type === 'integer' ? '1' : undefined}
        {...(entry.validations.min === undefined ? {} : { min: entry.validations.min })}
        {...(entry.validations.max === undefined ? {} : { max: entry.validations.max })}
        placeholder={entry.type === 'url' ? 'https://' : undefined}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </Field>
  )
}

/** A stored JSON value shown as something a person can edit. */
function formatJson(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Where to go when a record has no custom fields yet.
 *
 * Separate from the card, which renders nothing at all in that case: this is
 * for the one place it is worth saying, rather than on every record page.
 */
export function NoMetafieldsHint() {
  return (
    <p className="text-muted text-sm">
      No custom fields are defined yet. Add them in{' '}
      <span className="text-ink">Settings → Custom fields</span>.
    </p>
  )
}
