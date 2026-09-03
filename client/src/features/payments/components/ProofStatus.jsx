import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'

const STATE = {
  submitted: {
    tone: 'warn',
    label: 'Waiting to be checked',
    icon: Clock,
    line: 'We have your receipt. Someone will compare it against our bank statement — usually within a working day.',
  },
  approved: {
    tone: 'good',
    label: 'Payment confirmed',
    icon: CheckCircle2,
    line: 'Your payment has been matched and your order is confirmed. Nothing else to do.',
  },
  rejected: {
    tone: 'bad',
    label: 'Not matched',
    icon: XCircle,
    line: 'We could not match this against our statement.',
  },
}

/**
 * What became of the receipts already sent.
 *
 * The rejection note is the whole point of this component. When a shop turns a
 * receipt down it must write a reason — the database refuses a rejection
 * without one — and that sentence is the only part of the review the customer
 * can act on. Hiding it behind "rejected" turns a fixable mistake into an email
 * to support.
 *
 * Who reviewed it is deliberately not shown. Which member of staff looked at a
 * receipt is the shop's business, and naming them invites the argument to
 * become personal.
 */
export function ProofStatus({ proofs }) {
  if (proofs.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">
        {proofs.length === 1 ? 'Your receipt' : 'Receipts you have sent'}
      </h2>

      <ul className="flex flex-col gap-2">
        {proofs.map((proof) => {
          const state = STATE[proof.status] ?? {
            tone: 'neutral',
            label: proof.status,
            icon: Clock,
            line: '',
          }
          const Icon = state.icon

          return (
            <li key={proof.id} className="border-line bg-surface rounded-card border px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Icon
                    className={`size-4 ${proof.status === 'approved' ? 'text-good' : proof.status === 'rejected' ? 'text-bad' : 'text-warn'}`}
                    aria-hidden="true"
                  />
                  <Badge tone={state.tone}>{state.label}</Badge>
                </span>
                <span className="text-faint text-xs">
                  Sent{' '}
                  {new Date(proof.submittedAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
              </div>

              <p className="text-muted mt-2 text-sm">{state.line}</p>

              {proof.reviewNote ? (
                <p className="border-bad/25 bg-bad-soft text-bad mt-2 rounded-lg border px-3 py-2 text-sm">
                  {proof.reviewNote}
                </p>
              ) : null}

              <p className="text-faint mt-2 text-xs">
                You told us it came from {proof.senderName} at {proof.senderBank}.
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
