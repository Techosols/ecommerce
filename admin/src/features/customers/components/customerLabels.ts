import type { BadgeTone } from '@/components/ui/Badge'
import type { CustomerStatus, MarketingState, OptInLevel } from '../types/customers.types'

/**
 * The words the customer screens use, in one place.
 *
 * Consent especially: "Not subscribed" and "Unsubscribed" have to read as
 * different things at a glance, because they are — one may be asked, the other
 * must not be — and a shared grey pill for both is how that distinction gets
 * lost between the database and the person looking at the screen.
 */

export const STATUS_LABELS: Record<CustomerStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  locked: 'Locked',
}

export const STATUS_TONES: Record<CustomerStatus, BadgeTone> = {
  active: 'positive',
  disabled: 'neutral',
  locked: 'warning',
}

export const MARKETING_LABELS: Record<MarketingState, string> = {
  not_subscribed: 'Not subscribed',
  pending: 'Awaiting confirmation',
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
}

export const MARKETING_TONES: Record<MarketingState, BadgeTone> = {
  not_subscribed: 'neutral',
  pending: 'warning',
  subscribed: 'positive',
  // Not neutral: staff need to see at a glance that this one said no.
  unsubscribed: 'danger',
}

export const MARKETING_HINTS: Record<MarketingState, string> = {
  not_subscribed: 'Never asked, or asked and never answered. May be asked again.',
  pending: 'Asked, waiting for them to confirm.',
  subscribed: 'Agreed to marketing on this channel.',
  unsubscribed: 'Asked to stop. Do not send marketing on this channel.',
}

export const OPT_IN_LABELS: Record<OptInLevel, string> = {
  single_opt_in: 'Single opt-in',
  confirmed_opt_in: 'Confirmed opt-in',
  unknown: 'Unknown',
}

/**
 * Timeline entries.
 *
 * `kind` is open on the server, so anything not listed falls back to the raw
 * key with its underscores removed — an entry nobody has taught this map about
 * still appears, which is the point of an append-only record.
 */
export const EVENT_LABELS: Record<string, string> = {
  note: 'Note',
  'account.created_by_staff': 'Created by staff',
  'account.status_changed': 'Account status changed',
  'tags.added': 'Tags added',
  'tags.removed': 'Tags removed',
  'marketing.consent_changed': 'Marketing consent changed',
  'customer.merged': 'Merged from a duplicate',
}

export function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind.replace(/[._]/g, ' ')
}

export function customerName(customer: {
  firstName: string | null
  lastName: string | null
  email: string
}): string {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim()
  return name || customer.email
}

/**
 * A value out of an event's metadata, as text.
 *
 * `metadata` is open JSON written by whatever recorded the event, so anything
 * that is not a primitive falls back rather than rendering "[object Object]"
 * into somebody's timeline.
 */
export function metaText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}
