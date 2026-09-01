import type { Money } from '@/types/api'

/**
 * Display formatting.
 *
 * Every function here turns a server-supplied value into a string for a person
 * to read. None of them computes anything: no totals, no tax, no discounts, no
 * stock arithmetic. The division by 100 in `formatMoney` is a rendering step at
 * the very last moment, and its result is never fed back into a calculation —
 * the same rule the server keeps in `shared/format/money.ts`.
 */

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF'])

function minorUnitsPerMajor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100
}

export function formatMoney(value: Money | null | undefined, locale = 'en'): string {
  if (!value) return '—'
  const divisor = minorUnitsPerMajor(value.currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: value.currency.toUpperCase(),
    }).format(value.amount / divisor)
  } catch {
    const amount = (value.amount / divisor).toFixed(divisor === 1 ? 0 : 2)
    return `${value.currency.toUpperCase()} ${amount}`
  }
}

export function formatNumber(value: number | null | undefined, locale = 'en'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(locale).format(value)
}

export function formatPercent(value: number | null | undefined, locale = 'en'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(value / 100)
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(value: string | Date | null | undefined, locale = 'en'): string {
  const date = toDate(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

export function formatDateTime(value: string | Date | null | undefined, locale = 'en'): string {
  const date = toDate(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

/** "3 minutes ago" — for feeds where the exact timestamp is a tooltip. */
export function formatRelativeTime(value: string | Date | null | undefined, locale = 'en'): string {
  const date = toDate(value)
  if (!date) return '—'

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  let delta = (date.getTime() - Date.now()) / 1000

  for (const [unit, step] of RELATIVE_STEPS) {
    if (Math.abs(delta) < step) return formatter.format(Math.round(delta), unit)
    delta /= step
  }
  return formatter.format(Math.round(delta), 'year')
}

export function initialsOf(firstName?: string | null, lastName?: string | null, email?: string) {
  const first = firstName?.trim()?.[0]
  const last = lastName?.trim()?.[0]
  if (first || last) return `${first ?? ''}${last ?? ''}`.toUpperCase()
  return (email?.trim()?.[0] ?? '?').toUpperCase()
}

export function displayName(user: {
  firstName?: string | null
  lastName?: string | null
  email: string
}): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return full.length > 0 ? full : user.email
}
