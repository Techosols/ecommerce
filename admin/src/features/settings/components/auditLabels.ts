import type { BadgeTone } from '@/components/ui/Badge'

/** How an audit action reads, and how alarming it looks. */

/** `order.refunded` → "Order refunded". The verb is what happened. */
export function describeAction(action: string): string {
  const [resource = '', verb = ''] = action.split('.')
  const words = `${resource} ${verb}`.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The tone of a change, from its verb.
 *
 * Keyed on the verb rather than the resource, because "created" and "deleted"
 * mean the same thing to a person reading the trail whatever they happened to.
 */
export function toneOf(action: string): BadgeTone {
  const verb = action.split('.')[1] ?? ''
  if (/(deleted|archived|revoked|disabled|cancelled|refunded)/.test(verb)) return 'danger'
  if (/(created|restored|enabled|approved|invited)/.test(verb)) return 'positive'
  return 'neutral'
}
