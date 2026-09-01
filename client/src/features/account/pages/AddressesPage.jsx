import { useState } from 'react'
import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { messageOf } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AddressFields } from '@/features/checkout/components/AddressFields'
import { emptyAddress, validateAddress } from '@/features/checkout/address'
import { useAuth } from '../useAuth'
import {
  useAddresses,
  useCreateAddress,
  useRemoveAddress,
  useUpdateAddress,
} from '../hooks/profile.hooks'

/**
 * The address book.
 *
 * The same `AddressFields` the checkout uses, so an address that saves here is
 * one checkout will accept — a second form with its own idea of which fields
 * are required is how a saved address becomes unusable at the till.
 *
 * Two things the server decides and this screen must not:
 *
 *   • **Which address is the default.** Saving one as default unsets the
 *     previous one, and deleting the default promotes another. Both touch rows
 *     the response does not contain, so the list is re-read rather than
 *     patched — a client splicing its own array would show two defaults.
 *   • **What "delete" means.** It is a soft archive; an order placed to this
 *     address still refers to it. The wording says "Remove", not "Delete for
 *     ever", because the second would be a promise the server does not keep.
 */
export function AddressesPage() {
  const { isSignedIn } = useAuth()
  const query = useAddresses(isSignedIn)
  const [editing, setEditing] = useState(null)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl">Addresses</h2>
          <p className="text-muted text-sm">
            Saved here, offered at checkout. Your default is filled in first.
          </p>
        </div>
        {!editing ? (
          <Button
            variant="primary"
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => setEditing({ mode: 'new' })}
          >
            Add an address
          </Button>
        ) : null}
      </div>

      {editing ? (
        <AddressForm
          address={editing.address ?? null}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<Skeleton className="h-40 w-full" />}
      >
        {(query.data ?? []).length === 0 && !editing ? (
          <EmptyState
            icon={<MapPin className="size-6" />}
            title="No addresses saved"
            description="Add one and checkout will fill it in for you next time."
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {(query.data ?? []).map((address) => (
              <AddressCard
                key={address.id}
                address={address}
                onEdit={() => setEditing({ mode: 'edit', address })}
              />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  )
}

function AddressCard({ address, onEdit }) {
  const update = useUpdateAddress()
  const remove = useRemoveAddress()
  const [confirming, setConfirming] = useState(false)
  const busy = update.isPending || remove.isPending

  return (
    <li
      className={cn(
        'border-line bg-surface rounded-card flex flex-col gap-3 border p-5',
        address.isDefault && 'border-brand-300 bg-brand-50/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {address.label ? (
            <p className="text-ink text-sm font-semibold">{address.label}</p>
          ) : null}
          <p className="text-ink text-sm font-medium">
            {address.firstName} {address.lastName}
          </p>
        </div>
        {address.isDefault ? (
          <span className="text-brand-700 bg-brand-100 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
            <Star className="size-3" aria-hidden="true" />
            Default
          </span>
        ) : null}
      </div>

      <address className="text-muted text-sm not-italic">
        {address.company ? (
          <>
            {address.company}
            <br />
          </>
        ) : null}
        {address.line1}
        <br />
        {address.line2 ? (
          <>
            {address.line2}
            <br />
          </>
        ) : null}
        {[address.city, address.region, address.postalCode].filter(Boolean).join(', ')}
        <br />
        {address.countryCode}
        {address.phone ? (
          <>
            <br />
            {address.phone}
          </>
        ) : null}
      </address>

      {update.error || remove.error ? (
        <p className="text-bad text-xs">{messageOf(update.error ?? remove.error)}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" disabled={busy} onClick={onEdit}>
          <Pencil className="size-3.5" aria-hidden="true" />
          Edit
        </Button>

        {!address.isDefault ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => update.mutate({ id: address.id, patch: { isDefault: true } })}
          >
            Make default
          </Button>
        ) : null}

        {/* Never one click. The second press is the one that removes it. */}
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="primary"
              isLoading={remove.isPending}
              onClick={() => remove.mutate(address.id)}
            >
              Yes, remove it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-label={`Remove address ${address.label ?? address.line1}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="text-bad size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </li>
  )
}

function AddressForm({ address, onDone, onCancel }) {
  const create = useCreateAddress()
  const update = useUpdateAddress()
  const saving = create.isPending || update.isPending

  const [value, setValue] = useState(() => ({
    ...emptyAddress(),
    ...(address
      ? {
          firstName: address.firstName ?? '',
          lastName: address.lastName ?? '',
          company: address.company ?? '',
          line1: address.line1 ?? '',
          line2: address.line2 ?? '',
          city: address.city ?? '',
          region: address.region ?? '',
          postalCode: address.postalCode ?? '',
          countryCode: address.countryCode ?? '',
        }
      : {}),
  }))
  const [label, setLabel] = useState(address?.label ?? '')
  const [phone, setPhone] = useState(address?.phone ?? '')
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? false)
  const [errors, setErrors] = useState({})

  function submit(event) {
    event.preventDefault()
    const found = validateAddress(value)
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const blankToNull = (text) => (text.trim() === '' ? null : text.trim())
    const body = {
      label: blankToNull(label),
      firstName: value.firstName.trim(),
      lastName: value.lastName.trim(),
      company: blankToNull(value.company),
      line1: value.line1.trim(),
      line2: blankToNull(value.line2),
      city: value.city.trim(),
      region: blankToNull(value.region),
      postalCode: blankToNull(value.postalCode),
      countryCode: value.countryCode.trim().toUpperCase(),
      phone: blankToNull(phone),
      isDefault,
    }

    const mutation = address ? update : create
    const args = address ? { id: address.id, patch: body } : body
    mutation.mutate(args, { onSuccess: onDone })
  }

  const failure = create.error ?? update.error

  return (
    <form
      onSubmit={submit}
      className="border-line bg-surface rounded-card flex flex-col gap-4 border p-5"
    >
      <h3 className="text-base font-semibold">
        {address ? 'Edit this address' : 'A new address'}
      </h3>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="address-label" className="text-ink text-sm font-medium">
          Name it
        </label>
        <input
          id="address-label"
          maxLength={60}
          placeholder="Home, Work, Mum’s"
          className={input}
          value={label}
          disabled={saving}
          onChange={(event) => setLabel(event.target.value)}
        />
        <p className="text-muted text-xs">Optional — just so you can tell them apart.</p>
      </div>

      <AddressFields
        prefix="book"
        value={value}
        errors={errors}
        disabled={saving}
        onChange={setValue}
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="address-phone" className="text-ink text-sm font-medium">
          Phone
        </label>
        <input
          id="address-phone"
          type="tel"
          maxLength={32}
          className={input}
          value={phone}
          disabled={saving}
          onChange={(event) => setPhone(event.target.value)}
        />
        <p className="text-muted text-xs">For the courier, if they need it.</p>
      </div>

      <label className="text-ink-soft flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isDefault}
          disabled={saving}
          onChange={(event) => setIsDefault(event.target.checked)}
          className="accent-brand-600 size-4"
        />
        Use this one by default
      </label>

      {failure ? (
        <p className="border-bad/30 bg-bad-soft text-bad rounded-lg border px-3 py-2 text-sm">
          {messageOf(failure)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" isLoading={saving}>
          {address ? 'Save changes' : 'Save this address'}
        </Button>
        <Button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

const input =
  'border-line bg-surface text-ink placeholder:text-faint focus:border-brand-500 h-10 w-full rounded-lg border px-3 text-sm focus:outline-none disabled:opacity-60'
