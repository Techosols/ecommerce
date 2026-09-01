import { useState } from 'react'
import { Globe, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { TagsInput } from '@/components/ui/TagsInput'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useAuth } from '@/features/auth/useAuth'
import { useStoreCurrency } from '@/features/settings/store.hooks'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { describeMethod } from '../components/methodLabels'
import { MethodDialog } from '../components/MethodDialog'
import { RatePreview } from '../components/RatePreview'
import {
  useArchiveMethod,
  useArchiveZone,
  useCreateZone,
  useMethods,
  useUpdateZone,
  useZones,
} from '../hooks/shipping.hooks'
import type { ShippingMethod, ShippingZone } from '../types/shipping.types'

/**
 * Where the shop delivers, and what it charges.
 *
 * A zone is a set of countries and a method is a rule for pricing a parcel to
 * them, so the screen nests one inside the other rather than listing them
 * separately: a method means nothing without knowing where it applies, and a
 * zone with no methods means the store quietly does not deliver there — which
 * the empty state says outright rather than leaving as an inference.
 *
 * A country may only be in one live zone. The server refuses the second one and
 * names the first, because the alternative is two rate cards quoting the same
 * shopper and no way to tell which won.
 */
export function ShippingPage() {
  const { can } = useAuth()
  const currency = useStoreCurrency()
  useDocumentTitle('Shipping')

  const [showArchived, setShowArchived] = useState(false)
  const zones = useZones({ includeArchived: showArchived })
  const methods = useMethods()

  const [creatingZone, setCreatingZone] = useState(false)
  const [editingZone, setEditingZone] = useState<ShippingZone | null>(null)
  const [archivingZone, setArchivingZone] = useState<ShippingZone | null>(null)

  const canWrite = can('shipping:write')
  const live = (zones.data ?? []).filter((zone) => !zone.isArchived)
  const archived = (zones.data ?? []).filter((zone) => zone.isArchived)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Shipping"
        description="The countries the shop delivers to, and what each parcel costs."
        actions={
          canWrite ? (
            <Button
              variant="primary"
              leadingIcon={<Plus className="size-4" />}
              onClick={() => setCreatingZone(true)}
            >
              New zone
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <QueryBoundary
            isLoading={zones.isPending}
            error={zones.error}
            onRetry={() => void zones.refetch()}
          >
            {live.length === 0 && archived.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Globe className="size-5" />}
                  title="No delivery zones yet"
                  description="Until a zone exists with a method in it, the shop cannot quote delivery to anybody and checkout will refuse every order that needs shipping."
                  actions={
                    canWrite ? (
                      <Button onClick={() => setCreatingZone(true)}>Create the first zone</Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <>
                {live.map((zone) => (
                  <ZoneCard
                    key={zone.id}
                    zone={zone}
                    methods={(methods.data ?? []).filter((method) => method.zoneId === zone.id)}
                    currency={currency}
                    canWrite={canWrite}
                    onEdit={() => setEditingZone(zone)}
                    onArchive={() => setArchivingZone(zone)}
                  />
                ))}

                {archived.map((zone) => (
                  <Card key={zone.id} className="opacity-70">
                    <CardBody className="flex flex-wrap items-center gap-3">
                      <span className="text-ink font-medium">{zone.name}</span>
                      <Badge tone="neutral" size="sm">
                        Archived
                      </Badge>
                      <span className="text-faint text-xs">{zone.countryCodes.join(', ')}</span>
                    </CardBody>
                  </Card>
                ))}
              </>
            )}
          </QueryBoundary>

          {(zones.data ?? []).length > 0 ? (
            <label className="text-muted flex items-center gap-2 text-sm">
              <Switch
                checked={showArchived}
                onCheckedChange={setShowArchived}
                label="Show archived zones"
              />
              Show archived zones
            </label>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <RatePreview />
        </div>
      </div>

      {creatingZone ? <ZoneDialog zone={null} onClose={() => setCreatingZone(false)} /> : null}
      {editingZone ? <ZoneDialog zone={editingZone} onClose={() => setEditingZone(null)} /> : null}

      <ArchiveZoneDialog zone={archivingZone} onClose={() => setArchivingZone(null)} />
    </div>
  )
}

function ZoneCard({
  zone,
  methods,
  currency,
  canWrite,
  onEdit,
  onArchive,
}: {
  zone: ShippingZone
  methods: ShippingMethod[]
  currency: string
  canWrite: boolean
  onEdit: () => void
  onArchive: () => void
}) {
  const { toast } = useToast()
  const archiveMethod = useArchiveMethod()
  const [editingMethod, setEditingMethod] = useState<ShippingMethod | null>(null)
  const [addingMethod, setAddingMethod] = useState(false)
  const [removingMethod, setRemovingMethod] = useState<ShippingMethod | null>(null)

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {zone.name}
            {!zone.isActive ? (
              <Badge tone="warning" size="sm">
                Not quoting
              </Badge>
            ) : null}
          </span>
        }
        description={zone.countryCodes.join(', ')}
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onEdit}>
                Edit zone
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="hover:text-danger"
                leadingIcon={<Trash2 className="size-3.5" />}
                onClick={onArchive}
              >
                Archive
              </Button>
            </div>
          ) : undefined
        }
      />

      <CardBody>
        {methods.length === 0 ? (
          <p className="text-warning text-sm">
            No methods here, so nothing can be shipped to {zone.countryCodes.join(', ')}.
          </p>
        ) : (
          <ul className="divide-line divide-y">
            {methods.map((method) => (
              <li key={method.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="text-ink flex flex-wrap items-center gap-2 text-sm font-medium">
                    {method.name}
                    {!method.isActive ? (
                      <Badge tone="neutral" size="sm">
                        Off
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-faint block text-xs">
                    {describeMethod(method, currency)}
                  </span>
                </span>

                {canWrite ? (
                  <span className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditingMethod(method)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hover:text-danger"
                      onClick={() => setRemovingMethod(method)}
                    >
                      Remove
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canWrite ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Plus className="size-3.5" />}
              onClick={() => setAddingMethod(true)}
            >
              Add a method
            </Button>
          </div>
        ) : null}
      </CardBody>

      {addingMethod ? (
        <MethodDialog
          zoneId={zone.id}
          zoneName={zone.name}
          method={null}
          onClose={() => setAddingMethod(false)}
        />
      ) : null}

      {editingMethod ? (
        <MethodDialog
          zoneId={zone.id}
          zoneName={zone.name}
          method={editingMethod}
          onClose={() => setEditingMethod(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={removingMethod !== null}
        onCancel={() => setRemovingMethod(null)}
        onConfirm={() => {
          if (!removingMethod) return
          archiveMethod.mutate(removingMethod.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Method removed' })
              setRemovingMethod(null)
            },
            onError: (error) => {
              toast({ tone: 'error', title: 'Could not remove it', description: messageOf(error) })
              setRemovingMethod(null)
            },
          })
        }}
        title={`Remove ${removingMethod?.name ?? ''}?`}
        confirmLabel="Remove the method"
        tone="danger"
        isLoading={archiveMethod.isPending}
      >
        It stops being offered at checkout. Orders shipped by it keep naming it — the method is
        retired, not deleted.
      </ConfirmDialog>
    </Card>
  )
}

function ZoneDialog({ zone, onClose }: { zone: ShippingZone | null; onClose: () => void }) {
  const { toast } = useToast()
  const create = useCreateZone()
  const update = useUpdateZone()

  const [name, setName] = useState(zone?.name ?? '')
  const [countries, setCountries] = useState<string[]>(zone?.countryCodes ?? [])
  const [isActive, setActive] = useState(zone?.isActive ?? true)

  const pending = create.isPending || update.isPending
  const ready = name.trim() !== '' && countries.length > 0

  function submit() {
    if (!ready || pending) return

    const onSuccess = () => {
      toast({ tone: 'success', title: zone ? 'Zone updated' : 'Zone created' })
      onClose()
    }
    const onError = (error: unknown) =>
      toast({ tone: 'error', title: 'Could not save the zone', description: messageOf(error) })

    if (zone) {
      update.mutate(
        { id: zone.id, patch: { name: name.trim(), countryCodes: countries, isActive } },
        { onSuccess, onError },
      )
      return
    }
    create.mutate({ name: name.trim(), countryCodes: countries }, { onSuccess, onError })
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={zone ? `Edit ${zone.name}` : 'New delivery zone'}
      description="A set of countries that share a rate card."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} isLoading={pending} onClick={submit}>
            {zone ? 'Save zone' : 'Create zone'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required hint="For your own reference — shoppers never see it.">
          <Input
            value={name}
            placeholder="United Kingdom"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label="Countries"
          required
          hint="Two-letter codes. A country may only be in one live zone."
        >
          <TagsInput
            value={countries}
            maxLength={2}
            placeholder="GB, IE…"
            onChange={(codes) =>
              setCountries([
                ...new Set(
                  codes
                    .map((code) => code.trim().toUpperCase())
                    .filter((code) => /^[A-Z]{2}$/.test(code)),
                ),
              ])
            }
          />
        </Field>

        {zone ? (
          <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
            <div>
              <p className="text-ink text-sm font-medium">Quoting</p>
              <p className="text-muted mt-0.5 text-xs">
                Off keeps the zone and its methods but offers them to nobody, and frees its
                countries for another zone.
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setActive} label="Quoting" />
          </div>
        ) : null}

        <Alert tone="info">
          If a country is already covered by another live zone, the server refuses this and names
          the zone that has it.
        </Alert>
      </div>
    </Modal>
  )
}

function ArchiveZoneDialog({ zone, onClose }: { zone: ShippingZone | null; onClose: () => void }) {
  const { toast } = useToast()
  const archive = useArchiveZone()

  return (
    <ConfirmDialog
      isOpen={zone !== null}
      onCancel={onClose}
      onConfirm={() => {
        if (!zone) return
        archive.mutate(zone.id, {
          onSuccess: () => {
            toast({ tone: 'success', title: 'Zone archived' })
            onClose()
          },
          onError: (error) => {
            toast({ tone: 'error', title: 'Could not archive it', description: messageOf(error) })
            onClose()
          },
        })
      }}
      title={`Archive "${zone?.name ?? ''}"?`}
      confirmLabel="Archive the zone"
      tone="danger"
      isLoading={archive.isPending}
    >
      Nothing will be quoted to {zone?.countryCodes.join(', ') ?? 'those countries'} any more. Its
      methods are kept, because orders shipped by them still name them, and the zone can be restored
      while no other zone has claimed its countries.
    </ConfirmDialog>
  )
}
