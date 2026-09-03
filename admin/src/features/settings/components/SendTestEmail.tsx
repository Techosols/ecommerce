import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Alert } from '@/components/ui/Alert'
import { messageOf } from '@/lib/api/errors'
import { useSendTestEmail } from '../hooks/settings.hooks'

/**
 * "Does email work at all?"
 *
 * ── Why the address is asked for, not assumed ────────────────────────────────
 *
 * The obvious design is a button that mails the store's contact address. It is
 * also the design that hides the most common failure: a typical shared mail
 * server delivers to its own domain unconditionally and refuses to relay to
 * anywhere else. Under that configuration, mailing yourself succeeds while
 * every single customer email is refused — and the test reports success.
 *
 * So this asks where to send it, and says why. Testing against an outside
 * address is what separates "email is broken" from "email to customers is
 * broken", and those have completely different fixes.
 *
 * ── It answers half the question ─────────────────────────────────────────────
 *
 * A queued message is not a delivered one. The wording points at the log below,
 * because that is where the mail server's own verdict appears a moment later —
 * claiming success here would be claiming something this screen cannot know.
 */
export function SendTestEmail({ canEdit }: { canEdit: boolean }) {
  const [to, setTo] = useState('')
  const send = useSendTestEmail()

  return (
    <Card>
      <CardHeader
        title="Send a test email"
        description="Checks the whole path — settings, template, mail server — without placing an order to find out."
      />
      <CardBody className="flex flex-col gap-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (to.trim()) send.mutate(to.trim())
          }}
        >
          <Field
            label="Send it to"
            hint="Use an address outside your own domain — a personal Gmail will do. Mailing your own domain can succeed while everything to customers is being refused."
            className="min-w-64 flex-1"
          >
            <Input
              type="email"
              value={to}
              disabled={!canEdit || send.isPending}
              placeholder="you@gmail.com"
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>

          <Button
            type="submit"
            variant="secondary"
            leadingIcon={<Send className="size-4" />}
            disabled={!canEdit || !to.trim()}
            isLoading={send.isPending}
          >
            Send it
          </Button>
        </form>

        {send.isError ? <Alert tone="danger">{messageOf(send.error)}</Alert> : null}

        {send.isSuccess ? (
          // Careful wording: queued, not delivered. The log below is what knows.
          <Alert tone="info">
            Queued. Watch for it in the delivery log below — if the mail server
            refuses it, the reason will appear there within a few seconds.
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  )
}
