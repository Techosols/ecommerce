export interface StoreSettings {
  storeName: string
  contactEmail: string
  supportUrl: string | null
  supportPhone: string | null
  currency: string
  timezone: string
  weightUnit: 'g' | 'kg' | 'lb' | 'oz'
  /** Basis points: 875 = 8.75%. Integer arithmetic end to end (§4.1 rule 2). */
  taxRateBps: number
  pricesIncludeTax: boolean
  defaultLowStockThreshold: number
  orderNumberPrefix: string
  reservationTtlMinutes: number
  guestCheckoutEnabled: boolean

  // ── Cash on delivery policy (§5.7) ────────────────────────────────────────
  //
  // Commercial levers, not plumbing: each one is a way COD loses money, and
  // each is changeable by the owner without a deploy.
  codEnabled: boolean
  codMinSubtotalCents: number
  /** NULL means no ceiling. */
  codMaxSubtotalCents: number | null
  /** A handling surcharge, added to the order total. */
  codFeeCents: number
  /** Empty means everywhere the store ships; non-empty is a whitelist. */
  codCountryCodes: string[]
  codRequiresAccount: boolean
  /** Unpaid COD orders one customer may hold at once. NULL means no limit. */
  codMaxOpenOrders: number | null

  /**
   * How long a *placed order* holds its stock. Distinct from
   * `reservationTtlMinutes`, which is a cart hold: an hour is right for a
   * basket, and disastrous for an order. Must exceed the unpaid-order sweep
   * window, or stock is released while the order still looks live.
   */
  orderReservationHours: number

  logoMediaId: string | null
  metadata: Record<string, unknown>
  updatedAt: Date
  updatedBy: string | null
}

export type StoreSettingsUpdate = Partial<
  Omit<StoreSettings, 'updatedAt' | 'updatedBy' | 'metadata'>
> & { metadata?: Record<string, unknown> }

/**
 * The subset a storefront may read. Built by an explicit mapper, never by
 * omitting fields from the admin shape — a new column must be added here on
 * purpose before it becomes public (§23.14).
 */
export interface PublicStoreSettings {
  storeName: string
  contactEmail: string
  supportUrl: string | null
  currency: string
  timezone: string
  weightUnit: string
  guestCheckoutEnabled: boolean
  logoUrl: string | null
  /**
   * Whether COD is on at all. The thresholds, the whitelist and the open-order
   * cap stay private: they are the store's abuse controls, and publishing them
   * is publishing exactly what to stay under.
   */
  codEnabled: boolean
}
