/**
 * Customer DTOs (§7.3).
 *
 * Written twice, deliberately. The admin view carries lifetime spend and order
 * counts because that is what a shopkeeper needs; the customer's own view of
 * themselves does not, because it is not information they gave us and showing
 * it back reads as surveillance.
 */
import type { Address, CustomerEvent, CustomerSummary } from './customers.types.js'
import type { CustomerSegment } from './segments.service.js'

export function addressDto(address: Address) {
  return {
    id: address.id,
    label: address.label,
    firstName: address.firstName,
    lastName: address.lastName,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    phone: address.phone,
    isDefault: address.isDefault,
    createdAt: address.createdAt.toISOString(),
  }
}

/** What a customer sees about themselves. */
export function profileDto(customer: CustomerSummary) {
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    emailVerified: customer.emailVerified,
    acceptsMarketing: customer.acceptsMarketing,
    createdAt: customer.createdAt.toISOString(),
  }
}

/**
 * What an admin sees. Adds the commercial history.
 *
 * Currency is passed in rather than assumed: money crosses this boundary as
 * `{ amount, currency }` like everywhere else (docs/catalogue-model.md §5).
 */
export function adminCustomerDto(customer: CustomerSummary, currency: string) {
  return {
    ...profileDto(customer),
    status: customer.status,
    tags: customer.tags,
    adminNote: customer.adminNote,
    taxExempt: customer.taxExempt,
    locale: customer.locale,
    marketing: {
      email: customer.marketingEmailState,
      sms: customer.marketingSmsState,
      optInLevel: customer.marketingOptInLevel,
    },
    ordersCount: customer.ordersCount,
    totalSpent: { amount: customer.totalSpentCents, currency },
    // The average is derived here rather than stored: it is two numbers the
    // client already has, and a third stored copy is a third to keep right.
    averageOrderValue: {
      amount: customer.ordersCount > 0 ? Math.round(customer.totalSpentCents / customer.ordersCount) : 0,
      currency,
    },
    firstOrderAt: customer.firstOrderAt?.toISOString() ?? null,
    lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
  }
}

export function customerEventDto(event: CustomerEvent) {
  return {
    id: event.id,
    kind: event.kind,
    body: event.body,
    actorUserId: event.actorUserId,
    actorName: event.actorName,
    metadata: event.metadata,
    at: event.createdAt.toISOString(),
  }
}

export function segmentDto(
  segment: CustomerSegment & { memberCount?: number; summary?: string },
) {
  return {
    id: segment.id,
    name: segment.name,
    description: segment.description,
    rules: segment.rules,
    isActive: segment.isActive,
    ...(segment.memberCount === undefined ? {} : { memberCount: segment.memberCount }),
    ...(segment.summary === undefined ? {} : { summary: segment.summary }),
    createdAt: segment.createdAt.toISOString(),
    updatedAt: segment.updatedAt.toISOString(),
  }
}

/**
 * A CSV row per customer.
 *
 * Values are sanitised against formula injection: a cell beginning `=`, `+`,
 * `-` or `@` is executed by Excel when the file is opened, which turns an
 * export into a way to run code on the machine of whoever opens it. Prefixing
 * a quote makes it text.
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export const CSV_HEADERS = [
  'id', 'email', 'first_name', 'last_name', 'phone', 'status', 'tags',
  'email_marketing', 'sms_marketing', 'tax_exempt', 'orders', 'total_spent',
  'first_order_at', 'last_order_at', 'created_at',
] as const

export function customerCsvRow(customer: CustomerSummary): string {
  return [
    customer.id,
    customer.email,
    customer.firstName,
    customer.lastName,
    customer.phone,
    customer.status,
    customer.tags.join(' '),
    customer.marketingEmailState,
    customer.marketingSmsState,
    customer.taxExempt,
    customer.ordersCount,
    // Minor units, unformatted: a spreadsheet should get the number, not a
    // rendering of it in somebody else's locale.
    customer.totalSpentCents,
    customer.firstOrderAt?.toISOString() ?? '',
    customer.lastOrderAt?.toISOString() ?? '',
    customer.createdAt.toISOString(),
  ]
    .map(csvCell)
    .join(',')
}
