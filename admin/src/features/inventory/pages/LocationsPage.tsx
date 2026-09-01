import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, MapPin, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import {
  useArchiveLocation,
  useCreateLocation,
  useLocations,
  useUpdateLocation,
} from '../hooks/inventory.hooks'
import type { Location } from '../types/inventory.types'

/**
 * Where stock is held.
 *
 * Most shops have one and never open this page. The ones that matter are the
 * two decisions it makes explicit: which location is the **default** — where a
 * movement lands when nobody names one — and whether a location is **active**,
 * which is a different thing from archiving it.
 */
export function LocationsPage() {
  const { can } = useAuth()
  const { toast } = useToast()
  useDocumentTitle('Locations')

  const canManage = can('inventory:manage')
  const locations = useLocations()
  const archive = useArchiveLocation()

  const [editing, setEditing] = useState<Location | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Location | null>(null)

  const live = (locations.data ?? []).filter((location) => !location.isArchived)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to="/inventory"
          className="text-muted hover:text-ink inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-3.5" /> Inventory
        </Link>
      </div>

      <PageHeader
        title="Locations"
        description="Where stock is held. One is enough for most shops."
        actions={
          canManage ? (
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setEditing('new')}
            >
              New location
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary
        isLoading={locations.isPending}
        error={locations.error}
        onRetry={() => void locations.refetch()}
      >
        {live.length > 0 ? (
          <Card>
            <CardBody>
              <ul className="divide-line divide-y">
                {live.map((location) => (
                  <li key={location.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="text-ink flex flex-wrap items-center gap-2 font-medium">
                        {location.name}
                        {location.isDefault ? (
                          <Badge tone="brand" size="sm">
                            Default
                          </Badge>
                        ) : null}
                        {!location.isActive ? (
                          <Badge tone="neutral" size="sm">
                            Inactive
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-faint block text-xs">{location.code}</span>
                    </span>

                    {canManage ? (
                      <span className="flex shrink-0 gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(location)}>
                          Edit
                        </Button>
                        {/* The default cannot be archived: every movement that
                            names no location needs somewhere to land. */}
                        {!location.isDefault ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="hover:text-danger"
                            leadingIcon={<Trash2 className="size-3.5" />}
                            onClick={() => setArchiving(location)}
                          >
                            Archive
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={<MapPin className="size-5" />}
              title="No locations yet"
              description="A location is a place stock sits — a shop floor, a stockroom, a warehouse. Stock movements land at the default one unless you say otherwise."
              actions={
                canManage ? (
                  <Button onClick={() => setEditing('new')}>Create a location</Button>
                ) : undefined
              }
            />
          </Card>
        )}
      </QueryBoundary>

      {editing ? (
        <LocationDialog
          location={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={archiving !== null}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return
          archive.mutate(archiving.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Location archived' })
              setArchiving(null)
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not archive', description: messageOf(error) })
              setArchiving(null)
            },
          })
        }}
        title={`Archive "${archiving?.name ?? ''}"?`}
        confirmLabel="Archive location"
        tone="danger"
        isLoading={archive.isPending}
      >
        It stops being somewhere stock can move to. Its movement history is kept, and the server
        refuses if anything is still held there.
      </ConfirmDialog>
    </div>
  )
}

function LocationDialog({ location, onClose }: { location: Location | null; onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateLocation()
  const update = useUpdateLocation(location?.id ?? 'none')

  const [name, setName] = useState(location?.name ?? '')
  const [code, setCode] = useState(location?.code ?? '')
  const [isActive, setActive] = useState(location?.isActive ?? true)
  const [isDefault, setDefault] = useState(location?.isDefault ?? false)

  const pending = create.isPending || update.isPending
  const ready = name.trim() !== '' && code.trim() !== ''

  function submit() {
    if (!ready || pending) return

    const onSuccess = () => {
      toast({ tone: 'success', title: location ? 'Location updated' : 'Location created' })
      onClose()
    }
    const onError = (error: unknown) =>
      toast({ tone: 'error', title: 'Could not save the location', description: messageOf(error) })

    if (location) {
      update.mutate(
        { name: name.trim(), code: code.trim(), isActive, isDefault },
        { onSuccess, onError },
      )
      return
    }
    create.mutate({ name: name.trim(), code: code.trim(), isDefault }, { onSuccess, onError })
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={location ? 'Edit location' : 'New location'}
      description="A place stock physically sits."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={pending} onClick={submit}>
            {location ? 'Save location' : 'Create location'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required>
          <Input
            value={name}
            placeholder="Camden shop"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Code" required hint="Short and stable — it appears on stock reports.">
          <Input
            value={code}
            placeholder="camden"
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>

        {location ? (
          <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-ink text-sm font-medium">Active</p>
              <p className="text-muted mt-0.5 text-xs">
                Inactive locations keep their stock but are not offered for new movements.
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setActive} label="Active" />
          </div>
        ) : null}

        <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-ink text-sm font-medium">Default location</p>
            <p className="text-muted mt-0.5 text-xs">
              Where a stock movement lands when nobody names a location.
            </p>
          </div>
          <Switch
            checked={isDefault}
            disabled={location?.isDefault ?? false}
            onCheckedChange={setDefault}
            label="Default location"
          />
        </div>

        {isDefault && !location?.isDefault ? (
          <Alert tone="info">
            Making this the default moves that role off whichever location holds it now. Existing
            stock does not move.
          </Alert>
        ) : null}
      </div>
    </Modal>
  )
}
