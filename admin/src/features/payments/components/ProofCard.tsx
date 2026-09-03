import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ExternalLink, ImageOff, X } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { formatDateTime, formatMoney, formatRelativeTime } from '@/lib/format'
import { proofStatusLabels, proofStatusTones } from './paymentLabels'
import type { PaymentProof } from '../types/payments.types'

export interface ProofCardProps {
  proof: PaymentProof
  canDecide: boolean
  isBusy?: boolean
  onApprove: (proof: PaymentProof) => void
  onReject: (proof: PaymentProof) => void
}

/**
 * One receipt, laid out for the job of deciding about it.
 *
 * The job is a comparison: does this screenshot, against this bank statement,
 * justify marking this order paid? So the two things being compared sit side by
 * side — the image on the left at a size you can actually read a figure in, and
 * the order's own total on the right, set large. Everything else is smaller,
 * because everything else is context.
 *
 * **The claim is visually quarantined.** Sender, bank and account digits sit in
 * a sunken block under the words "Customer says", set in the mono face used for
 * data elsewhere in the admin. That framing is doing real work: these fields
 * were typed by an anonymous person into a public form, and a reviewer who
 * reads them as facts the system verified is a reviewer who will eventually
 * approve a forgery. The order total, by contrast, is the shop's own number and
 * is styled as such.
 *
 * Cards rather than table rows. A table asks you to compare rows against each
 * other; this queue asks you to consider one item at a time against something
 * outside the screen entirely, and a row cannot hold a legible screenshot.
 */
export function ProofCard({ proof, canDecide, isBusy = false, onApprove, onReject }: ProofCardProps) {
  const [zoomed, setZoomed] = useState(false)
  const pending = proof.status === 'submitted'

  return (
    <Card>
      <CardBody className="flex flex-col gap-4 sm:flex-row sm:gap-5">
        {/* ── The evidence ─────────────────────────────────────────────── */}
        <div className="shrink-0">
          {proof.imageUrl ? (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              aria-label="View the full receipt"
              className="ring-line hover:ring-brand-600 block overflow-hidden rounded-lg ring-1 transition-shadow"
            >
              {/* `contain`, never `cover`. A bank receipt is a tall portrait
                  screenshot and this frame is square: cropping it cuts off the
                  amount at the top or the "successful" stamp at the bottom,
                  which are the two things the reviewer is looking for. Letting
                  it letterbox shows the whole receipt, small but complete. */}
              <img
                src={proof.imageUrl}
                alt=""
                loading="lazy"
                className="bg-surface-sunken h-40 w-40 object-contain sm:h-44 sm:w-44"
              />
            </button>
          ) : (
            <div className="bg-surface-sunken ring-line text-faint flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-lg ring-1 sm:h-44 sm:w-44">
              <ImageOff aria-hidden="true" className="size-5" />
              <span className="px-3 text-center text-xs">Image unavailable</span>
            </div>
          )}
        </div>

        {/* ── What it is meant to pay for ──────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {proof.order ? (
                  <Link
                    to={`/orders/${proof.orderId}`}
                    className="text-brand-600 text-sm font-medium hover:underline"
                  >
                    {proof.order.orderNumber}
                  </Link>
                ) : (
                  <span className="text-ink text-sm font-medium">This order</span>
                )}
                <Badge tone={proofStatusTones[proof.status]} size="sm">
                  {proofStatusLabels[proof.status]}
                </Badge>
              </div>
              {proof.order ? (
                <p className="text-muted mt-0.5 truncate text-xs">{proof.order.email}</p>
              ) : null}
            </div>

            {/* The figure being checked against. The shop's own number, so it
                is the one thing here set at size. */}
            {proof.order ? (
              <div className="text-right">
                <p className="text-ink tabular text-lg leading-none font-semibold">
                  {formatMoney(proof.order.total)}
                </p>
                <p className="text-faint mt-1 text-xs">Order total</p>
              </div>
            ) : null}
          </div>

          {/* ── The claim, quarantined ─────────────────────────────────── */}
          <div className="bg-surface-sunken rounded-lg px-3 py-2.5">
            <p className="text-faint mb-1.5 text-[0.6875rem] font-medium tracking-wide uppercase">
              Customer says
            </p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted shrink-0">Sent by</dt>
                <dd className="text-ink tabular truncate">{proof.claim.senderName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted shrink-0">Bank</dt>
                <dd className="text-ink tabular truncate">{proof.claim.senderBank}</dd>
              </div>
              {proof.claim.accountLast4 ? (
                <div className="flex gap-2">
                  <dt className="text-muted shrink-0">Account ending</dt>
                  <dd className="text-ink tabular">•••• {proof.claim.accountLast4}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-muted shrink-0">Sent</dt>
                <dd className="text-ink" title={formatDateTime(proof.submittedAt)}>
                  {formatRelativeTime(proof.submittedAt)}
                </dd>
              </div>
            </dl>
          </div>

          {/* ── The decision ───────────────────────────────────────────── */}
          {pending ? (
            canDecide ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isBusy}
                  leadingIcon={<Check className="size-4" />}
                  onClick={() => onApprove(proof)}
                >
                  Approve and mark paid
                </Button>
                <Button
                  size="sm"
                  disabled={isBusy}
                  leadingIcon={<X className="size-4" />}
                  onClick={() => onReject(proof)}
                >
                  Reject
                </Button>
              </div>
            ) : (
              <p className="text-muted text-xs">
                You can see this receipt but not decide about it.
              </p>
            )
          ) : (
            <ReviewOutcome proof={proof} />
          )}
        </div>
      </CardBody>

      {/* Full size, because a figure on a phone screenshot is unreadable at
          176px and squinting is how the wrong number gets approved. */}
      {proof.imageUrl ? (
        <Modal
          isOpen={zoomed}
          onClose={() => setZoomed(false)}
          title={proof.order ? `Receipt for ${proof.order.orderNumber}` : 'Receipt'}
          size="lg"
          footer={
            <>
              <a
                href={proof.imageUrl}
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 mr-auto inline-flex items-center gap-1.5 text-sm hover:underline"
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                Open original
              </a>
              <Button onClick={() => setZoomed(false)}>Close</Button>
            </>
          }
        >
          <img src={proof.imageUrl} alt="" className="mx-auto max-h-[70vh] w-auto rounded-lg" />
        </Modal>
      ) : null}
    </Card>
  )
}

/** What happened to a receipt that has already been decided. */
function ReviewOutcome({ proof }: { proof: PaymentProof }) {
  return (
    <div className="text-muted flex flex-col gap-1 text-xs">
      <p>
        {proof.status === 'approved' ? 'Approved' : 'Rejected'}
        {proof.reviewedByName ? ` by ${proof.reviewedByName}` : ''}
        {proof.reviewedAt ? ` · ${formatDateTime(proof.reviewedAt)}` : ''}
      </p>
      {proof.reviewNote ? (
        // Shown to the customer too, so staff can see exactly what was said.
        <p className="text-ink border-line border-l-2 pl-2 italic">“{proof.reviewNote}”</p>
      ) : null}
    </div>
  )
}
