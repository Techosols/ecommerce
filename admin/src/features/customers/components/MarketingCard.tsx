import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/toast.context'
import { messageOf } from '@/lib/api/errors'
import { formatDate } from '@/lib/format'
import { useSetConsent } from '../hooks/customers.hooks'
import {
  MARKETING_HINTS,
  MARKETING_LABELS,
  MARKETING_TONES,
  OPT_IN_LABELS,
} from './customerLabels'
import type { CustomerDetail, MarketingState } from '../types/customers.types'

export interface MarketingCardProps {
  customer: CustomerDetail
  canWrite: boolean
}

const STATES = Object.keys(MARKETING_LABELS) as MarketingState[]

/**
 * Consent, as the four states it actually has.
 *
 * Not a switch. A switch has two positions and consent has four, and the two it
 * would collapse are the two that matter: `not_subscribed` is somebody who has
 * never been asked, `unsubscribed` is somebody who said no. Mailing the first is
 * normal marketing; mailing the second is the thing every shop that stored
 * consent as one bit eventually did by accident.
 *
 * Email and SMS are set separately, because agreeing to one is not agreeing to
 * the other.
 */
export function MarketingCard({ customer, canWrite }: MarketingCardProps) {
  const { toast } = useToast()
  const setConsent = useSetConsent(customer.id)

  function change(channel: 'email' | 'sms', state: MarketingState) {
    setConsent.mutate(
      { channel, state },
      {
        onSuccess: () =>
          toast({
            tone: 'success',
            title: `${channel === 'sms' ? 'SMS' : 'Email'} marketing updated`,
            description: MARKETING_HINTS[state],
          }),
        onError: (error) =>
          toast({
            tone: 'error',
            title: 'Could not change consent',
            description: messageOf(error),
          }),
      },
    )
  }

  const options = STATES.map((state) => ({ value: state, label: MARKETING_LABELS[state] }))

  return (
    <Card>
      <CardHeader
        title="Marketing"
        description="Consent is per channel, and every change is recorded on the timeline."
      />

      <CardBody className="flex flex-col gap-4">
        <Field label="Email" hint={MARKETING_HINTS[customer.marketing.email]}>
          {canWrite ? (
            <Select
              value={customer.marketing.email}
              disabled={setConsent.isPending}
              onChange={(event) => change('email', event.target.value as MarketingState)}
              options={options}
            />
          ) : (
            <Badge tone={MARKETING_TONES[customer.marketing.email]}>
              {MARKETING_LABELS[customer.marketing.email]}
            </Badge>
          )}
        </Field>

        <Field label="SMS" hint={MARKETING_HINTS[customer.marketing.sms]}>
          {canWrite ? (
            <Select
              value={customer.marketing.sms}
              disabled={setConsent.isPending}
              onChange={(event) => change('sms', event.target.value as MarketingState)}
              options={options}
            />
          ) : (
            <Badge tone={MARKETING_TONES[customer.marketing.sms]}>
              {MARKETING_LABELS[customer.marketing.sms]}
            </Badge>
          )}
        </Field>

        {/* How the yes was obtained. Kept because "how do you know they agreed"
            is not answered by a state on its own. */}
        <dl className="text-muted flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt>Opt-in level</dt>
            <dd className="text-ink">
              {customer.marketing.optInLevel
                ? OPT_IN_LABELS[customer.marketing.optInLevel]
                : 'Not recorded'}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Customer since</dt>
            <dd className="text-ink">{formatDate(customer.createdAt)}</dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  )
}
