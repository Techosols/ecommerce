import { useState } from 'react'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import type { AddressInput, DraftAddress, DraftDetail, DraftPatch } from '../types/drafts.types'

/**
 * Who it is for and where it goes.
 *
 * Edited as a form and saved in one request rather than field-by-field: a
 * quote taken over the phone is typed in one go, and re-pricing on every
 * keystroke would make the totals flicker while somebody is still talking.
 *
 * Nothing here is validated for correctness beyond what a form can know. The
 * server decides whether an address is enough to deliver to, and says so in
 * the blockers.
 */
export function DraftDetailsCard({
  draft,
  onSave,
  isSaving,
  readOnly,
}: {
  draft: DraftDetail
  onSave: (patch: DraftPatch) => void
  isSaving: boolean
  readOnly: boolean
}) {
  const shipping = draft.addresses.find((address) => address.type === 'shipping')

  const [email, setEmail] = useState(draft.email ?? '')
  const [phone, setPhone] = useState(draft.phone ?? '')
  const [note, setNote] = useState(draft.customerNote ?? '')
  const [address, setAddress] = useState<AddressInput>(() => toInput(shipping))

  const field =
    (key: keyof AddressInput) =>
    (event: { target: { value: string } }) =>
      setAddress((current) => ({ ...current, [key]: event.target.value }))

  function save() {
    onSave({
      email: email.trim(),
      phone: phone.trim() || null,
      customerNote: note.trim() || null,
      // Sent only once it is filled in far enough to be an address at all.
      // A half-typed one would be rejected as a 422, which reads as a bug
      // rather than as "keep going".
      ...(address.line1.trim() && address.city.trim() && address.countryCode.trim().length === 2
        ? {
            shippingAddress: {
              ...address,
              countryCode: address.countryCode.trim().toUpperCase(),
              company: address.company?.trim() || null,
              line2: address.line2?.trim() || null,
              region: address.region?.trim() || null,
              postalCode: address.postalCode?.trim() || null,
              phone: phone.trim() || null,
            },
          }
        : {}),
    })
  }

  return (
    <Card>
      <CardHeader
        title="Customer and delivery"
        description="Where the order is confirmed to, and where it is sent."
      />

      <CardBody className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" required hint="Where the confirmation goes.">
          <Input
            type="email"
            value={email}
            disabled={readOnly}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Phone">
          <Input
            value={phone}
            disabled={readOnly}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>

        <Field label="First name" required>
          <Input value={address.firstName} disabled={readOnly} onChange={field('firstName')} />
        </Field>

        <Field label="Last name" required>
          <Input value={address.lastName} disabled={readOnly} onChange={field('lastName')} />
        </Field>

        <Field label="Address" required className="sm:col-span-2">
          <Input value={address.line1} disabled={readOnly} onChange={field('line1')} />
        </Field>

        <Field label="Address line 2" className="sm:col-span-2">
          <Input value={address.line2 ?? ''} disabled={readOnly} onChange={field('line2')} />
        </Field>

        <Field label="City" required>
          <Input value={address.city} disabled={readOnly} onChange={field('city')} />
        </Field>

        <Field label="Region">
          <Input value={address.region ?? ''} disabled={readOnly} onChange={field('region')} />
        </Field>

        <Field label="Postcode">
          <Input
            value={address.postalCode ?? ''}
            disabled={readOnly}
            onChange={field('postalCode')}
          />
        </Field>

        <Field label="Country" required hint="Two letters, e.g. GB.">
          <Input
            value={address.countryCode}
            maxLength={2}
            disabled={readOnly}
            onChange={field('countryCode')}
          />
        </Field>

        <Field label="Note" className="sm:col-span-2" hint="Shown on the order.">
          <Textarea
            rows={2}
            value={note}
            disabled={readOnly}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </CardBody>

      {readOnly ? null : (
        <CardFooter>
          <span className="text-faint text-xs">
            Saving re-prices the draft against this address.
          </span>
          <Button variant="primary" isLoading={isSaving} onClick={save}>
            Save details
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function toInput(address: DraftAddress | undefined): AddressInput {
  return {
    firstName: address?.firstName ?? '',
    lastName: address?.lastName ?? '',
    company: address?.company ?? '',
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    city: address?.city ?? '',
    region: address?.region ?? '',
    postalCode: address?.postalCode ?? '',
    countryCode: address?.countryCode ?? '',
  }
}
