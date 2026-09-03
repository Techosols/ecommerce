import { useState } from 'react'
import { Lock } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import { TagsInput } from '@/components/ui/TagsInput'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useToast } from '@/components/ui/toast.context'
import { useAuth } from '@/features/auth/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { messageOf } from '@/lib/api/errors'
import { EmailLog } from '../components/EmailLog'
import { SendTestEmail } from '../components/SendTestEmail'
import {
  useEmailTemplates,
  useSetEmailTemplate,
  useStoreSettingsAdmin,
  useUpdateStoreSettings,
} from '../hooks/settings.hooks'
import type { EmailTemplateSetting } from '../types/settings.types'

/**
 * What the shop sends, in the words of what actually happens.
 *
 * The wire keys are `order-placed`, `admin-payment-proof`. Nobody choosing
 * whether to send something should have to read a template key, so every one
 * gets a sentence describing the moment it fires.
 */
const COPY: Record<string, { title: string; when: string }> = {
  welcome: { title: 'Welcome', when: 'After somebody confirms their email address.' },
  'order-placed': { title: 'Order received', when: 'The moment an order is placed.' },
  'order-confirmed': { title: 'Order confirmed', when: 'When payment lands and the order is ready to pack.' },
  'order-shipped': { title: 'Order shipped', when: 'When a parcel is marked as sent.' },
  'order-delivered': { title: 'Order delivered', when: 'When a parcel is marked as arrived.' },
  'order-cancelled': { title: 'Order cancelled', when: 'When an order is cancelled, by you or by the sweep.' },
  'order-refunded': { title: 'Refund sent', when: 'When money goes back to a customer.' },
  'cart-abandoned': { title: 'Abandoned basket', when: 'A reminder to somebody who left items behind. Marketing — it also respects their consent.' },
  'email-verification': { title: 'Confirm your email', when: 'On registration.' },
  'password-reset': { title: 'Reset your password', when: 'When somebody asks to reset.' },
  'password-changed': { title: 'Password changed', when: 'After a password is changed or reset.' },
  'account-exists': { title: 'You already have an account', when: 'When somebody registers with an address that already exists.' },
  'staff-invitation': { title: 'Staff invitation', when: 'When you invite a colleague.' },
  'system-check': { title: 'Delivery test', when: 'Only when you send one, to check email works.' },
  'admin-order-placed': { title: 'New order', when: 'Tells your team an order came in, with payment and shipping details.' },
  'admin-payment-proof': { title: 'Receipt to review', when: 'Tells your team a customer sent a bank transfer receipt.' },
}

const describe = (template: string) =>
  COPY[template] ?? { title: template, when: 'Sent by the shop.' }

/** Alerts to your own team, versus mail to customers. */
const isStaffAlert = (template: string) => template.startsWith('admin-')

export function EmailsPage() {
  useDocumentTitle('Emails')
  const { can } = useAuth()
  const query = useEmailTemplates()
  const canEdit = can('settings:write')

  return (
    <div className="flex flex-col gap-4">
      <RecipientsCard canEdit={canEdit} />

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {(() => {
          const all = query.data ?? []
          const staff = all.filter((row) => isStaffAlert(row.template))
          const customer = all.filter((row) => !isStaffAlert(row.template) && !row.alwaysOn)
          const locked = all.filter((row) => row.alwaysOn)

          return (
            <>
              <TemplateCard
                title="Alerts to your team"
                description="Sent to the addresses above, not to customers."
                rows={staff}
                canEdit={canEdit}
              />
              <TemplateCard
                title="Emails to customers"
                description="Sent automatically as an order moves through the shop."
                rows={customer}
                canEdit={canEdit}
              />
              <TemplateCard
                title="Account and security"
                description="These always send."
                rows={locked}
                canEdit={canEdit}
              />

              {/* Last, because together they answer the question the switches
                  above raise: "I turned it on — did it actually go?" */}
              <SendTestEmail canEdit={canEdit} />
              <EmailLog canEdit={canEdit} />
            </>
          )
        })()}
      </QueryBoundary>
    </div>
  )
}

// ── Who hears about things ───────────────────────────────────────────────────

function RecipientsCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast()
  const query = useStoreSettingsAdmin()
  const update = useUpdateStoreSettings()
  const [draft, setDraft] = useState<string[] | null>(null)

  const saved = query.data?.adminNotificationEmails ?? []
  const value = draft ?? saved
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)

  return (
    <Card>
      <CardHeader
        title="Who gets the alerts"
        description="Your team's addresses. Not the store contact address — that one is printed in customer emails and gets their replies."
      />
      <CardBody className="flex flex-col gap-3">
        <Field
          label="Addresses"
          hint="Each alert is sent to everyone here, as a separate message. Leave it empty to switch alerts off entirely."
        >
          {/* The server's own limits, not the tag defaults: an email address
              is routinely longer than forty characters, and the schema accepts
              ten of them at 320 characters each. Matching them here means the
              field cannot compose a request the API will refuse — which it
              would do for the whole list, losing every address at once. */}
          <TagsInput
            value={value}
            disabled={!canEdit || update.isPending}
            placeholder="you@yourshop.com"
            maxTags={10}
            maxLength={320}
            onChange={setDraft}
          />
        </Field>

        {value.length === 0 ? (
          <Alert tone="info">
            Nobody is listed, so no alerts are being sent. Add an address to start receiving them.
          </Alert>
        ) : null}

        {dirty ? (
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { adminNotificationEmails: draft ?? [] },
                  {
                    onSuccess: () => {
                      setDraft(null)
                      toast({ tone: 'success', title: 'Saved' })
                    },
                    onError: (error) =>
                      toast({
                        tone: 'error',
                        title: 'Could not save',
                        description: messageOf(error),
                      }),
                  },
                )
              }
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" disabled={update.isPending} onClick={() => setDraft(null)}>
              Discard
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

// ── The switches ─────────────────────────────────────────────────────────────

function TemplateCard({
  title,
  description,
  rows,
  canEdit,
}: {
  title: string
  description: string
  rows: EmailTemplateSetting[]
  canEdit: boolean
}) {
  const { toast } = useToast()
  const setTemplate = useSetEmailTemplate()

  if (rows.length === 0) return null

  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="flex flex-col">
        {rows.map((row, index) => {
          const copy = describe(row.template)
          return (
            <div
              key={row.template}
              className={
                index === 0
                  ? 'flex items-start justify-between gap-4 py-2'
                  : 'border-line flex items-start justify-between gap-4 border-t py-3'
              }
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-ink text-sm font-medium">{copy.title}</p>
                  {row.alwaysOn ? (
                    <Lock aria-hidden="true" className="text-faint size-3" />
                  ) : null}
                </div>
                <p className="text-muted mt-0.5 text-xs">{copy.when}</p>
                {/* The server's reason, shown rather than a bare disabled
                    switch — otherwise somebody spends ten minutes looking for
                    a control that was deliberately withheld. */}
                {row.alwaysOnReason ? (
                  <p className="text-faint mt-1 text-xs italic">{row.alwaysOnReason}</p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {row.alwaysOn ? (
                  <span className="text-faint text-xs">Always on</span>
                ) : (
                  <Switch
                    checked={row.enabled}
                    disabled={!canEdit || setTemplate.isPending}
                    label={`Send the ${copy.title} email`}
                    onCheckedChange={(checked) =>
                      setTemplate.mutate(
                        { template: row.template, enabled: checked },
                        {
                          onSuccess: () =>
                            toast({
                              tone: 'success',
                              title: checked
                                ? `${copy.title} will be sent`
                                : `${copy.title} is switched off`,
                            }),
                          onError: (error) =>
                            toast({
                              tone: 'error',
                              title: 'Could not change that',
                              description: messageOf(error),
                            }),
                        },
                      )
                    }
                  />
                )}
              </div>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

