import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Filter, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Drawer } from '@/components/ui/Drawer'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { RuleBuilder, EMPTY_RULES, completeRules, type RuleSet } from '@/components/rules'
import { useAuth } from '@/features/auth/useAuth'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import {
  useCreateSegment,
  useDeleteSegment,
  usePreviewSegment,
  useRuleFields,
  useSegments,
  useUpdateSegment,
} from '../hooks/customers.hooks'
import type { CustomerSegment } from '../types/customers.types'

/**
 * Saved rule sets, counted live.
 *
 * A segment stores no membership. The rules are compiled to SQL and run on
 * every read, because a stored list of members is correct until the next order
 * and then it is a list of customers who *used to* match — the one thing a
 * segment must never be. Every count on this page is therefore a query, not a
 * cached number.
 */
export function SegmentsPage() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Segments')

  const canWrite = can('customers:write')
  const segments = useSegments()
  const remove = useDeleteSegment()

  const [editing, setEditing] = useState<CustomerSegment | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CustomerSegment | null>(null)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/customers"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Customers
        </Link>
      </div>

      <PageHeader
        title="Segments"
        description="Saved questions about your customers, answered fresh every time you ask."
        actions={
          canWrite ? (
            <Button leadingIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New segment
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary
        isLoading={segments.isPending}
        error={segments.error}
        onRetry={() => void segments.refetch()}
      >
        {segments.data && segments.data.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {segments.data.map((segment) => (
              <li key={segment.id}>
                <Card className="h-full">
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        {segment.name}
                        {!segment.isActive ? <Badge tone="neutral">Inactive</Badge> : null}
                      </span>
                    }
                    description={segment.description ?? segment.summary}
                  />
                  <CardBody className="flex flex-col gap-4">
                    <p className="text-ink text-2xl font-semibold tabular">
                      {formatNumber(segment.memberCount ?? 0)}
                      <span className="text-muted ml-1.5 text-sm font-normal">
                        {segment.memberCount === 1 ? 'customer' : 'customers'}
                      </span>
                    </p>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        leadingIcon={<Filter className="size-3.5" />}
                        onClick={() => void navigate(`/customers?segmentId=${segment.id}`)}
                      >
                        View customers
                      </Button>
                      {canWrite ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(segment)}>
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="hover:text-danger"
                            leadingIcon={<Trash2 className="size-3.5" />}
                            onClick={() => setDeleting(segment)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Card>
            <EmptyState
              icon={<Filter className="size-5" />}
              title="No segments yet"
              description="A segment is a set of rules — everyone who has spent over £500, everyone tagged wholesale — that the customer list can be narrowed to."
              actions={
                canWrite ? (
                  <Button onClick={() => setEditing('new')}>Create a segment</Button>
                ) : undefined
              }
            />
          </Card>
        )}
      </QueryBoundary>

      {editing ? (
        <SegmentDrawer
          segment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Segment deleted' })
              setDeleting(null)
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not delete', description: messageOf(error) })
              setDeleting(null)
            },
          })
        }}
        title={`Delete "${deleting?.name ?? ''}"?`}
        confirmLabel="Delete segment"
        tone="danger"
        isLoading={remove.isPending}
      >
        Only the saved rules go. No customer is changed or removed.
      </ConfirmDialog>
    </div>
  )
}

interface SegmentDrawerProps {
  segment: CustomerSegment | null
  onClose: () => void
}

/**
 * Writing a segment, with the answer on screen while you write it.
 *
 * The preview is the whole point: rules are easy to write and easy to get
 * subtly wrong, and "142 customers, here are five of them" is the only thing
 * that tells you whether the rules mean what you think. It is asked for when
 * the rules settle rather than on every keystroke.
 */
function SegmentDrawer({ segment, onClose }: SegmentDrawerProps) {
  const { toast } = useToast()
  const fields = useRuleFields()
  const create = useCreateSegment()
  const update = useUpdateSegment(segment?.id ?? 'none')
  const preview = usePreviewSegment()

  const [name, setName] = useState(segment?.name ?? '')
  const [description, setDescription] = useState(segment?.description ?? '')
  const [isActive, setActive] = useState(segment?.isActive ?? true)
  const [rules, setRules] = useState<RuleSet>(segment?.rules ?? EMPTY_RULES)

  // Settled rules, not every keystroke: the preview is a query per change.
  const settled = useDebouncedValue(JSON.stringify(completeRules(rules)), 500)
  useEffect(() => {
    preview.mutate(JSON.parse(settled) as RuleSet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  const isPending = create.isPending || update.isPending

  function save() {
    if (isPending || name.trim() === '') return
    const body = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      rules: completeRules(rules),
      isActive,
    }

    const onSuccess = () => {
      toast({ tone: 'success', title: segment ? 'Segment updated' : 'Segment created' })
      onClose()
    }
    const onError = (error: unknown) =>
      toast({ tone: 'error', title: 'Could not save the segment', description: messageOf(error) })

    if (segment) update.mutate(body, { onSuccess, onError })
    else create.mutate(body, { onSuccess, onError })
  }

  return (
    <Drawer
      isOpen
      onClose={onClose}
      size="lg"
      title={segment ? 'Edit segment' : 'New segment'}
      description="Rules are checked against the shop every time the segment is read, so a segment is never out of date."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={name.trim() === ''} isLoading={isPending} onClick={save}>
            {segment ? 'Save segment' : 'Create segment'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label="Description">
          <Textarea
            rows={2}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div>
          <p className="text-ink mb-2 text-sm font-medium">Rules</p>
          <QueryBoundary
            isLoading={fields.isPending}
            error={fields.error}
            onRetry={() => void fields.refetch()}
          >
            <RuleBuilder value={rules} onChange={setRules} fields={fields.data ?? []} subject="Customers" />
          </QueryBoundary>
        </div>

        <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-ink text-sm font-medium">Active</p>
            <p className="text-muted mt-0.5 text-xs">
              An inactive segment stays saved but is not offered as a filter.
            </p>
          </div>
          <Switch checked={isActive} onCheckedChange={setActive} label="Active" />
        </div>

        <Card>
          <CardHeader title="Preview" description="What these rules match right now." />
          <CardBody className="flex flex-col gap-3">
            {preview.isPending ? (
              <p className="text-muted text-sm">Counting…</p>
            ) : preview.error ? (
              <p className="text-danger text-sm">{messageOf(preview.error)}</p>
            ) : preview.data ? (
              <>
                <p className="text-ink text-2xl font-semibold tabular">
                  {formatNumber(preview.data.memberCount)}
                  <span className="text-muted ml-1.5 text-sm font-normal">
                    {preview.data.memberCount === 1 ? 'customer' : 'customers'}
                  </span>
                </p>
                <p className="text-muted text-xs">{preview.data.summary}</p>

                {preview.data.sample.length > 0 ? (
                  <ul className="text-ink-soft flex flex-col gap-1 text-sm">
                    {preview.data.sample.map((row) => (
                      <li key={row.id} className="truncate">
                        {row.name ? `${row.name} · ` : ''}
                        <span className="text-faint">{row.email}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </Drawer>
  )
}
