import type { BadgeTone } from '@/components/ui/Badge'
import type { MovementReason, OperatorReason } from '../types/inventory.types'

/**
 * The words the inventory screens use.
 *
 * The reason vocabulary is split deliberately: `OPERATOR_LABELS` is what a
 * person may choose, and the rest are written by the system. A dropdown that
 * offered "reservation" would let somebody file a sale as a shelf count.
 */

export const OPERATOR_LABELS: Record<OperatorReason, string> = {
  receive: 'Received a delivery',
  manual_adjustment: 'Manual adjustment',
  stocktake: 'Stock count',
  damage: 'Damaged',
  waste: 'Waste',
  return: 'Customer return',
  correction: 'Correction',
}

export const REASON_LABELS: Record<MovementReason, string> = {
  ...OPERATOR_LABELS,
  transfer_in: 'Transferred in',
  transfer_out: 'Transferred out',
  reservation: 'Reserved',
  reservation_release: 'Reservation released',
  reservation_commit: 'Sold',
  reservation_expired: 'Reservation expired',
}

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason as MovementReason] ?? reason.replace(/_/g, ' ')
}

/**
 * Reasons that take stock away read as losses; the rest are neutral.
 *
 * Not keyed on the sign of the delta: a `correction` can go either way and is
 * not bad news, while `damage` is bad news whichever way somebody entered it.
 */
export const REASON_TONES: Partial<Record<MovementReason, BadgeTone>> = {
  receive: 'positive',
  return: 'positive',
  damage: 'danger',
  waste: 'danger',
  reservation_commit: 'info',
}

export function reasonTone(reason: string): BadgeTone {
  return REASON_TONES[reason as MovementReason] ?? 'neutral'
}

/** How a movement's effect reads: "+12", "−3", or "—" when it moved nothing. */
export function signed(value: number): string {
  if (value === 0) return '—'
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`
}

export function ownerLabel(owner: { type: string; id: string }, orderNumber: string | null): string {
  if (owner.type === 'order') return orderNumber ?? 'An order'
  if (owner.type === 'cart') return 'A basket in checkout'
  return 'Held by staff'
}
