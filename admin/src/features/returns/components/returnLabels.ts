import type { BadgeTone } from '@/components/ui/Badge'
import type { ReturnCondition, ReturnReason, ReturnStatus } from '../types/returns.types'

/**
 * The vocabulary of a returns desk, in one place.
 *
 * The tones say what needs attention: amber is waiting on us, blue is in
 * motion, green is settled, neutral is over. `declined` and `cancelled` are
 * neutral rather than red — refusing a return is a normal outcome, not a
 * failure, and colouring it as one makes a busy queue look alarming.
 */
export const statusTones: Record<ReturnStatus, { tone: BadgeTone; label: string }> = {
  requested: { tone: 'warning', label: 'Requested' },
  approved: { tone: 'info', label: 'Approved' },
  in_transit: { tone: 'info', label: 'On its way' },
  received: { tone: 'positive', label: 'Received' },
  closed: { tone: 'neutral', label: 'Closed' },
  declined: { tone: 'neutral', label: 'Declined' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
}

export const reasonLabels: Record<ReturnReason, string> = {
  damaged: 'Arrived damaged',
  wrong_item: 'Wrong item',
  not_as_described: 'Not as described',
  no_longer_wanted: 'No longer wanted',
  arrived_late: 'Arrived late',
  other: 'Other',
}

/**
 * What each condition means for stock, said plainly.
 *
 * The operator choosing here is deciding whether goods go back on sale, so the
 * label says so rather than leaving them to infer it from the word.
 */
export const conditionLabels: Record<ReturnCondition, { label: string; effect: string }> = {
  resellable: { label: 'Resellable', effect: 'Goes back on the shelf' },
  damaged: { label: 'Damaged', effect: 'Written off' },
  opened: { label: 'Opened', effect: 'Written off' },
  missing_parts: { label: 'Missing parts', effect: 'Written off' },
}
