import type { BadgeTone } from '@/components/ui/Badge'
import type { PaymentMethod, PaymentStatus, ProofStatus } from '../types/payments.types'

/**
 * How each method reads on screen.
 *
 * The wire values are snake_case keys; nobody reconciling a statement should
 * have to read `bank_transfer`.
 */
export const methodLabels: Record<PaymentMethod, string> = {
  cod: 'Cash on delivery',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  manual: 'Recorded by staff',
}

export const statusLabels: Record<PaymentStatus, string> = {
  pending: 'Pending',
  authorized: 'Authorized',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
}

/**
 * Colour carries meaning, so it is assigned by what the operator should do.
 *
 * `pending` is warning rather than neutral: money that has not arrived is the
 * thing worth noticing on a page full of money that has.
 */
export const statusTones: Record<PaymentStatus, BadgeTone> = {
  pending: 'warning',
  authorized: 'info',
  paid: 'positive',
  failed: 'danger',
  cancelled: 'neutral',
  refunded: 'neutral',
  partially_refunded: 'info',
}

export const proofStatusLabels: Record<ProofStatus, string> = {
  submitted: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
}

export const proofStatusTones: Record<ProofStatus, BadgeTone> = {
  submitted: 'warning',
  approved: 'positive',
  rejected: 'danger',
}
