/**
 * Store settings data access (§1.2). SQL only.
 *
 * There is exactly one row, guaranteed by `CHECK (id = 1)` and seeded by the
 * migration, so every read is a primary-key lookup and no caller has to handle
 * "no settings yet".
 */
import { queryOne } from '../../infrastructure/database/query.js'
import type { StoreSettings, StoreSettingsUpdate } from './settings.types.js'

interface SettingsRow {
  store_name: string
  contact_email: string
  support_url: string | null
  support_phone: string | null
  currency: string
  timezone: string
  weight_unit: 'g' | 'kg' | 'lb' | 'oz'
  tax_rate_bps: number
  prices_include_tax: boolean
  default_low_stock_threshold: number
  order_number_prefix: string
  reservation_ttl_minutes: number
  guest_checkout_enabled: boolean
  cod_enabled: boolean
  cod_min_subtotal_cents: number
  cod_max_subtotal_cents: number | null
  cod_fee_cents: number
  cod_country_codes: string[]
  cod_requires_account: boolean
  cod_max_open_orders: number | null
  bank_transfer_enabled: boolean
  bank_account_name: string | null
  bank_name: string | null
  bank_account_number: string | null
  bank_iban: string | null
  bank_swift: string | null
  bank_instructions: string | null
  admin_notification_emails: string[]
  order_reservation_hours: number
  logo_media_id: string | null
  metadata: Record<string, unknown>
  updated_at: Date
  updated_by: string | null
}

function toSettings(row: SettingsRow): StoreSettings {
  return {
    storeName: row.store_name,
    contactEmail: row.contact_email,
    supportUrl: row.support_url,
    supportPhone: row.support_phone,
    currency: row.currency,
    timezone: row.timezone,
    weightUnit: row.weight_unit,
    taxRateBps: row.tax_rate_bps,
    pricesIncludeTax: row.prices_include_tax,
    defaultLowStockThreshold: row.default_low_stock_threshold,
    orderNumberPrefix: row.order_number_prefix,
    reservationTtlMinutes: row.reservation_ttl_minutes,
    guestCheckoutEnabled: row.guest_checkout_enabled,
    codEnabled: row.cod_enabled,
    codMinSubtotalCents: row.cod_min_subtotal_cents,
    codMaxSubtotalCents: row.cod_max_subtotal_cents,
    codFeeCents: row.cod_fee_cents,
    codCountryCodes: row.cod_country_codes ?? [],
    codRequiresAccount: row.cod_requires_account,
    codMaxOpenOrders: row.cod_max_open_orders,
    bankTransferEnabled: row.bank_transfer_enabled,
    bankAccountName: row.bank_account_name,
    bankName: row.bank_name,
    bankAccountNumber: row.bank_account_number,
    bankIban: row.bank_iban,
    bankSwift: row.bank_swift,
    bankInstructions: row.bank_instructions,
    adminNotificationEmails: row.admin_notification_emails ?? [],
    orderReservationHours: row.order_reservation_hours,
    logoMediaId: row.logo_media_id,
    metadata: row.metadata,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

/** Update field → column. Anything absent here simply cannot be written. */
const COLUMNS: Record<keyof StoreSettingsUpdate, string> = {
  storeName: 'store_name',
  contactEmail: 'contact_email',
  supportUrl: 'support_url',
  supportPhone: 'support_phone',
  currency: 'currency',
  timezone: 'timezone',
  weightUnit: 'weight_unit',
  taxRateBps: 'tax_rate_bps',
  pricesIncludeTax: 'prices_include_tax',
  defaultLowStockThreshold: 'default_low_stock_threshold',
  orderNumberPrefix: 'order_number_prefix',
  reservationTtlMinutes: 'reservation_ttl_minutes',
  guestCheckoutEnabled: 'guest_checkout_enabled',
  codEnabled: 'cod_enabled',
  codMinSubtotalCents: 'cod_min_subtotal_cents',
  codMaxSubtotalCents: 'cod_max_subtotal_cents',
  codFeeCents: 'cod_fee_cents',
  codCountryCodes: 'cod_country_codes',
  codRequiresAccount: 'cod_requires_account',
  codMaxOpenOrders: 'cod_max_open_orders',
  bankTransferEnabled: 'bank_transfer_enabled',
  bankAccountName: 'bank_account_name',
  bankName: 'bank_name',
  bankAccountNumber: 'bank_account_number',
  bankIban: 'bank_iban',
  bankSwift: 'bank_swift',
  bankInstructions: 'bank_instructions',
  adminNotificationEmails: 'admin_notification_emails',
  orderReservationHours: 'order_reservation_hours',
  logoMediaId: 'logo_media_id',
  metadata: 'metadata',
}

export const settingsRepository = {
  async get(): Promise<StoreSettings> {
    const row = await queryOne<SettingsRow>(`SELECT * FROM store_settings WHERE id = 1`, [], {
      name: 'settings.get',
    })
    if (!row) {
      // Seeded by migration 0006; its absence means the schema is not what the
      // code expects, which should fail loudly rather than be papered over.
      throw new Error('store_settings row is missing — migration 0006 has not been applied')
    }
    return toSettings(row)
  },

  /** Locks the row so two concurrent admin edits serialise (§18.3). */
  async getForUpdate(): Promise<StoreSettings> {
    const row = await queryOne<SettingsRow>(
      `SELECT * FROM store_settings WHERE id = 1 FOR UPDATE`,
      [],
      { name: 'settings.getForUpdate' },
    )
    if (!row) throw new Error('store_settings row is missing')
    return toSettings(row)
  },

  async update(patch: StoreSettingsUpdate, actorUserId: string | null): Promise<StoreSettings> {
    const assignments: string[] = []
    const params: unknown[] = []

    for (const [field, column] of Object.entries(COLUMNS) as [
      keyof StoreSettingsUpdate,
      string,
    ][]) {
      const value = patch[field]
      if (value === undefined) continue
      // The column name comes from the allowlist above, never from input.
      params.push(field === 'metadata' ? JSON.stringify(value) : value)
      assignments.push(`${column} = $${params.length}`)
    }

    params.push(actorUserId)
    assignments.push(`updated_by = $${params.length}`)

    const row = await queryOne<SettingsRow>(
      `UPDATE store_settings SET ${assignments.join(', ')} WHERE id = 1 RETURNING *`,
      params,
      { name: 'settings.update' },
    )
    if (!row) throw new Error('store_settings row is missing')
    return toSettings(row)
  },
}
