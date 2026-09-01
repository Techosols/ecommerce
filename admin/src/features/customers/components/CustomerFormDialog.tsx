import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { TagsInput } from '@/components/ui/TagsInput'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { useCreateCustomer } from '../hooks/customers.hooks'
import { MARKETING_HINTS, MARKETING_LABELS } from './customerLabels'
import type { CustomerAccess, MarketingState } from '../types/customers.types'

export interface CustomerFormDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated?: (customerId: string) => void
}

/**
 * Creating a customer by hand — a phone order, a wholesale account, somebody
 * migrated from a spreadsheet.
 *
 * Access is an explicit choice with three answers rather than an implied one.
 * The default is `none`: a record that exists and cannot be signed into, which
 * is what a phone customer actually is. An invite mails them a link to set
 * their own password; setting one here is for the rare case where somebody is
 * standing next to you.
 *
 * Consent defaults to "not subscribed" and has to be moved deliberately.
 * Nothing here ticks a marketing box on somebody's behalf.
 */
export function CustomerFormDialog({ isOpen, onClose, onCreated }: CustomerFormDialogProps) {
  const { toast } = useToast()
  const create = useCreateCustomer()

  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [adminNote, setAdminNote] = useState('')
  const [taxExempt, setTaxExempt] = useState(false)
  const [marketing, setMarketing] = useState<MarketingState>('not_subscribed')
  const [access, setAccess] = useState<CustomerAccess>('none')
  const [password, setPassword] = useState('')

  function reset() {
    setEmail('')
    setFirstName('')
    setLastName('')
    setPhone('')
    setTags([])
    setAdminNote('')
    setTaxExempt(false)
    setMarketing('not_subscribed')
    setAccess('none')
    setPassword('')
  }

  function submit() {
    if (create.isPending || email.trim() === '') return

    create.mutate(
      {
        email: email.trim(),
        access,
        ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(adminNote.trim() ? { adminNote: adminNote.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(taxExempt ? { taxExempt: true } : {}),
        ...(marketing !== 'not_subscribed' ? { marketingEmailState: marketing } : {}),
        ...(access === 'password' ? { password } : {}),
      },
      {
        onSuccess: (customer) => {
          toast({
            tone: 'success',
            title: 'Customer created',
            ...(access === 'invite'
              ? { description: 'They have been emailed a link to set a password.' }
              : {}),
          })
          reset()
          onClose()
          onCreated?.(customer.id)
        },
        onError: (error) =>
          toast({
            tone: 'error',
            title: 'Could not create the customer',
            description: messageOf(error),
          }),
      },
    )
  }

  const passwordTooShort = access === 'password' && password.length < 8

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="New customer"
      description="A record the shop can order against. An account is optional."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={email.trim() === '' || passwordTooShort}
            isLoading={create.isPending}
            onClick={submit}
          >
            Create customer
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Email" required hint="Their identity in the shop. It cannot be changed here.">
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </Field>
        </div>

        <Field label="Phone">
          <Input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </Field>

        <Field label="Tags">
          <TagsInput value={tags} onChange={setTags} />
        </Field>

        <Field label="Note" hint="One pinned line. The timeline holds the running record.">
          <Textarea
            rows={2}
            maxLength={2000}
            value={adminNote}
            onChange={(event) => setAdminNote(event.target.value)}
          />
        </Field>

        <div className="border-line flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-ink text-sm font-medium">Tax exempt</p>
            <p className="text-muted mt-0.5 text-xs">Charged no tax at checkout.</p>
          </div>
          <Switch checked={taxExempt} onCheckedChange={setTaxExempt} label="Tax exempt" />
        </div>

        <Field label="Email marketing" hint={MARKETING_HINTS[marketing]}>
          <Select
            value={marketing}
            onChange={(event) => setMarketing(event.target.value as MarketingState)}
            options={(Object.keys(MARKETING_LABELS) as MarketingState[]).map((state) => ({
              value: state,
              label: MARKETING_LABELS[state],
            }))}
          />
        </Field>

        <Field label="Account access">
          <Select
            value={access}
            onChange={(event) => setAccess(event.target.value as CustomerAccess)}
            options={[
              { value: 'none', label: 'No sign-in — a record only' },
              { value: 'invite', label: 'Email them a link to set a password' },
              { value: 'password', label: 'Set a password now' },
            ]}
          />
        </Field>

        {access === 'password' ? (
          <>
            <Field
              label="Password"
              required
              error={passwordTooShort && password !== '' ? 'At least 8 characters.' : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Alert tone="warning">
              You will have to tell them this password yourself. An invite is safer: it never
              travels through anyone else.
            </Alert>
          </>
        ) : null}
      </div>
    </Drawer>
  )
}
