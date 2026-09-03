/**
 * The courier seam.
 *
 * ── Why an interface rather than a TCS client ────────────────────────────────
 *
 * A shop changes courier. It changes courier when one loses a parcel, when
 * another undercuts them, and when it starts shipping to a city the first does
 * not cover — and it very often runs two at once. A codebase that calls a
 * named courier from inside its fulfilment logic has to be operated on every
 * time that happens.
 *
 * So the same shape the email and storage subsystems already use: business code
 * asks for *a courier* and gets whichever one is configured. Adding TCS,
 * Leopards or M&P is then one new file implementing this, and nothing in
 * shipping, orders or the storefront changes.
 *
 * ── Every method is optional, on purpose ─────────────────────────────────────
 *
 * Couriers differ enormously in what they expose. Some book consignments over a
 * REST API and push scan events back; some have tracking but no booking; some
 * have no API at all and hand over a spreadsheet once a week. Making the
 * capabilities optional — and *declared* — means the shop can offer exactly the
 * buttons a given courier can honour, rather than showing a "Book with courier"
 * action that fails for half of them.
 *
 * `capabilities` is what the admin reads to decide what to render. A provider
 * that declares a capability must implement the matching method; the registry
 * checks that at startup rather than at the moment a parcel needs to go out.
 *
 * ── What a provider must never do ────────────────────────────────────────────
 *
 * **Never decide what the customer pays.** A quote here is an input to the
 * shop's own pricing, not the price. `shippingService` still owns the rate that
 * reaches a shopper, because a courier's API being slow, wrong or down must not
 * be able to change a basket total.
 *
 * **Never move an order's status.** A provider reports what the courier said; a
 * scan event becomes a shipment status through the shipping service's own
 * transitions, so every rule about partial shipment and derived fulfilment
 * status stays in one place.
 *
 * **Never throw for an ordinary refusal.** A courier that cannot serve an
 * address returns no quotes; that is an answer, not an error. Exceptions are
 * for the courier being unreachable or refusing the credentials.
 */

export interface CarrierCapabilities {
  /** Can price a parcel for a destination. */
  quotes: boolean
  /** Can create a consignment and return a tracking number. */
  booking: boolean
  /** Can report scan events, by polling or by webhook. */
  tracking: boolean
  /** Can account for cash collected on delivery. */
  remittance: boolean
}

/** Where a parcel is going, and what is in it. */
export interface CarrierQuoteRequest {
  destination: {
    countryCode: string
    city: string | null
    postalCode: string | null
  }
  weightGrams: number
  /** The goods' value, for insurance and for cash-on-delivery. */
  subtotalCents: number
  currency: string
  /** True when the courier will be collecting the money at the door. */
  cashOnDelivery: boolean
}

/**
 * One service the courier will sell for this parcel.
 *
 * `amountCents` is what the *courier* charges the shop. What the shopper is
 * asked for is the shipping service's decision, which may add a handling fee,
 * round it, or ignore it entirely in favour of a flat rate.
 */
export interface CarrierQuote {
  /** The courier's own service code, stored on the shipment when booked. */
  serviceCode: string
  serviceName: string
  amountCents: number
  currency: string
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

export interface CarrierBookingRequest {
  orderNumber: string
  serviceCode: string | null
  /** Who it is going to. */
  recipient: {
    name: string
    phone: string | null
    email: string | null
    line1: string
    line2: string | null
    city: string
    region: string | null
    postalCode: string | null
    countryCode: string
  }
  parcel: {
    weightGrams: number
    /** One line per item, for the courier's manifest and for customs. */
    contents: { description: string; quantity: number }[]
    valueCents: number
    currency: string
  }
  /** Non-zero when the courier must collect this at the door. */
  codAmountCents: number
}

export interface CarrierBooking {
  trackingNumber: string
  trackingUrl: string | null
  /** The courier's own consignment id, when it differs from the tracking number. */
  consignmentId: string | null
  /** A printable label, when the courier returns one. */
  label: { contentType: string; data: Buffer } | null
  /** What the courier says it will charge, if it says. */
  amountCents: number | null
}

/**
 * The shop's vocabulary, which every courier's own status is mapped into.
 *
 * Deliberately the shipment statuses that already exist rather than a new set:
 * a courier reporting "AT_HUB_LHR" is interesting to nobody, and translating it
 * at the edge means the rest of the system keeps one vocabulary.
 */
export type CarrierShipmentStatus =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'failed'

export interface CarrierTrackingEvent {
  status: CarrierShipmentStatus
  /** The courier's own words, shown to staff beside the mapped status. */
  description: string
  location: string | null
  occurredAt: Date
  /** The courier's raw code, kept so a mis-mapping can be diagnosed later. */
  rawStatus: string | null
}

export interface CarrierTrackingUpdate {
  trackingNumber: string
  events: CarrierTrackingEvent[]
}

/** One line of a courier's cash-on-delivery statement. */
export interface CarrierRemittanceLine {
  trackingNumber: string
  /** What the courier says it collected. */
  collectedCents: number
  /** What it deducted for delivery. */
  feeCents: number
  /** What it actually paid the shop. */
  netCents: number
  currency: string
  collectedAt: Date | null
  reference: string | null
}

export interface CarrierProvider {
  /** Stable machine name: `manual`, `tcs`, `leopards`. */
  readonly name: string
  /** What an operator sees in Settings. */
  readonly label: string
  readonly capabilities: CarrierCapabilities

  /**
   * What the courier would charge. An empty list means "not to that address",
   * which is an answer rather than a failure.
   */
  quote?(request: CarrierQuoteRequest): Promise<CarrierQuote[]>

  /** Creates the consignment. The tracking number it returns is authoritative. */
  book?(request: CarrierBookingRequest): Promise<CarrierBooking>

  /** Everything the courier knows about a parcel, newest last. */
  track?(trackingNumber: string): Promise<CarrierTrackingUpdate>

  /** Cancels a consignment that has not yet been collected. */
  cancel?(trackingNumber: string): Promise<void>

  /**
   * Turns a pushed callback into tracking events.
   *
   * **This method is the authentication for the webhook route, and there is no
   * other.** Couriers differ in where they put the signature and what they sign,
   * so the route cannot verify on a provider's behalf; it hands over the exact
   * bytes and headers received — a signature computed over re-serialised JSON
   * verifies nothing — and an implementation that does not check them has made
   * the shipment table writable by anybody who can guess a tracking number.
   * Throw for a bad or missing signature; return null when the payload is
   * genuine but carries nothing to record.
   */
  parseWebhook?(raw: Buffer, headers: Record<string, string | undefined>): CarrierTrackingUpdate | null

  /**
   * Reads a remittance statement.
   *
   * A file rather than an API call because that is how this actually arrives
   * from most couriers — a CSV or an XLSX, emailed weekly. A provider with a
   * real endpoint can ignore the bytes and fetch instead.
   */
  parseRemittance?(file: Buffer, filename: string): Promise<CarrierRemittanceLine[]>
}
