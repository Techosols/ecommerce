import { v7 as uuidv7 } from 'uuid'
import { execute, query, queryOne } from '../../infrastructure/database/query.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import { getCarrier } from '../../infrastructure/carriers/index.js'
import type {
  CarrierBooking,
  CarrierBookingRequest,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierTrackingEvent,
  CarrierTrackingUpdate,
} from '../../infrastructure/carriers/index.js'

const log = createLogger('shipping.carrier')

/**
 * The shop's dealings with whichever courier is connected.
 *
 * The provider knows how to talk to one courier. This knows what the *shop*
 * does about the answers — and, more importantly, what it does when there is no
 * answer, which is the part that decides whether a courier outage becomes a
 * shop outage.
 *
 * ── The rule every method here follows ───────────────────────────────────────
 *
 * **A courier is an opinion, not an authority.** It can be slow, wrong, down,
 * or not configured at all, and none of those may stop somebody buying
 * something or a parcel going out. So every call is bounded by a timeout, every
 * failure is caught and logged, and every caller gets a null that means "carry
 * on as you did before couriers were pluggable".
 *
 * That is also why the manual provider exists: with it, every method below
 * returns null and the shop behaves exactly as it did.
 */

/**
 * How long the shop will wait for a courier.
 *
 * Deliberately short for quoting: it sits in the checkout request, and a
 * shopper staring at a spinner is a shopper leaving. Booking may take longer
 * because a person pressed a button and is expecting something to happen.
 */
const QUOTE_TIMEOUT_MS = 2_500
const BOOK_TIMEOUT_MS = 15_000
const TRACK_TIMEOUT_MS = 10_000

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`carrier ${what} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface TrackingEventRow {
  id: string
  status: string
  description: string
  location: string | null
  rawStatus: string | null
  occurredAt: Date
  provider: string
}

export const carrierService = {
  /** What the shop can currently do with a courier, for the admin to render. */
  capabilities() {
    const carrier = getCarrier()
    return { provider: carrier.name, label: carrier.label, ...carrier.capabilities }
  },

  /**
   * What the courier would charge, or null.
   *
   * Null covers every reason there is no courier price — none configured, it
   * cannot quote, it timed out, it refused, it does not serve the address — and
   * the caller treats them identically, because for pricing purposes they are
   * identical: use the shop's own rates.
   *
   * A courier failure is logged at warn and nowhere else. It must never reach a
   * shopper: "we could not contact the courier" is not a thing to say to
   * somebody trying to buy a lipstick.
   */
  async quote(request: CarrierQuoteRequest): Promise<CarrierQuote[] | null> {
    const carrier = getCarrier()
    if (!carrier.capabilities.quotes || !carrier.quote) return null

    try {
      const quotes = await withTimeout(carrier.quote(request), QUOTE_TIMEOUT_MS, 'quote')
      return quotes.length > 0 ? quotes : null
    } catch (error) {
      log.warn({ err: error, provider: carrier.name }, 'carrier quote failed; using shop rates')
      return null
    }
  },

  /**
   * Creates the consignment, or null when there is nothing to create it with.
   *
   * Unlike quoting, a failure here is **rethrown**. Booking happens because
   * somebody pressed "Ship" and is waiting to be told what happened; silently
   * falling back to no tracking number would produce a shipment that looks
   * booked and is not, and a parcel nobody has told the courier about.
   */
  async book(request: CarrierBookingRequest): Promise<CarrierBooking | null> {
    const carrier = getCarrier()
    if (!carrier.capabilities.booking || !carrier.book) return null

    const booking = await withTimeout(carrier.book(request), BOOK_TIMEOUT_MS, 'book')
    log.info(
      { provider: carrier.name, orderNumber: request.orderNumber, tracking: booking.trackingNumber },
      'consignment booked',
    )
    return booking
  },

  /** Everything the courier knows about a parcel, or null. */
  async track(trackingNumber: string): Promise<CarrierTrackingUpdate | null> {
    const carrier = getCarrier()
    if (!carrier.capabilities.tracking || !carrier.track) return null

    try {
      return await withTimeout(carrier.track(trackingNumber), TRACK_TIMEOUT_MS, 'track')
    } catch (error) {
      log.warn({ err: error, provider: carrier.name, trackingNumber }, 'carrier tracking failed')
      return null
    }
  },

  // ── The trail ─────────────────────────────────────────────────────────────

  /**
   * Records scans against a shipment, ignoring ones already known.
   *
   * `ON CONFLICT DO NOTHING` against the uniqueness constraint is what makes
   * this safe to call repeatedly — and it is called repeatedly, because polling
   * re-reads a parcel's whole history every time and every courier that has a
   * webhook redelivers it.
   *
   * Returns only the events that were genuinely new, which is what the caller
   * needs in order to decide whether anything actually changed.
   */
  async recordEvents(
    shipmentId: string,
    provider: string,
    events: CarrierTrackingEvent[],
  ): Promise<CarrierTrackingEvent[]> {
    const recorded: CarrierTrackingEvent[] = []

    for (const event of events) {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO shipment_tracking_events
           (id, shipment_id, status, description, location, raw_status, occurred_at, provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT ON CONSTRAINT shipment_tracking_events_once DO NOTHING
         RETURNING id`,
        [
          uuidv7(),
          shipmentId,
          event.status,
          event.description,
          event.location,
          event.rawStatus,
          event.occurredAt,
          provider,
        ],
        { name: 'carrier.recordEvent' },
      )
      if (row) recorded.push(event)
    }

    return recorded
  },

  async eventsFor(shipmentId: string): Promise<TrackingEventRow[]> {
    const rows = await query<{
      id: string
      status: string
      description: string
      location: string | null
      raw_status: string | null
      occurred_at: Date
      provider: string
    }>(
      `SELECT id, status, description, location, raw_status, occurred_at, provider
         FROM shipment_tracking_events
        WHERE shipment_id = $1
        ORDER BY occurred_at DESC`,
      [shipmentId],
      { name: 'carrier.eventsFor' },
    )

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      description: row.description,
      location: row.location,
      rawStatus: row.raw_status,
      occurredAt: row.occurred_at,
      provider: row.provider,
    }))
  },

  /**
   * The parcels worth asking about.
   *
   * Only those a courier booked and that have not finished moving — a delivered
   * parcel has nothing left to say, and polling for it forever is a request per
   * parcel per interval, for ever.
   */
  async inFlight(limit: number): Promise<{ id: string; trackingNumber: string }[]> {
    const rows = await query<{ id: string; tracking_number: string }>(
      `SELECT id, tracking_number
         FROM shipments
        WHERE tracking_number IS NOT NULL
          AND carrier_provider IS NOT NULL
          AND status NOT IN ('delivered','returned','failed')
        ORDER BY updated_at
        LIMIT $1`,
      [limit],
      { name: 'carrier.inFlight' },
    )
    return rows.map((row) => ({ id: row.id, trackingNumber: row.tracking_number }))
  },

  /** Notes which courier booked a parcel, so tracking asks the right one. */
  async attachBooking(shipmentId: string, provider: string, booking: CarrierBooking) {
    await execute(
      `UPDATE shipments
          SET carrier_provider = $2,
              carrier_consignment_id = $3,
              tracking_number = COALESCE($4, tracking_number),
              tracking_url = COALESCE($5, tracking_url)
        WHERE id = $1`,
      [shipmentId, provider, booking.consignmentId, booking.trackingNumber, booking.trackingUrl],
      { name: 'carrier.attachBooking' },
    )
  },

  /** Finds the shipment a courier's tracking number belongs to. */
  async shipmentByTracking(
    trackingNumber: string,
  ): Promise<{ id: string; orderId: string; status: string } | undefined> {
    return queryOne<{ id: string; orderId: string; status: string }>(
      `SELECT id, order_id AS "orderId", status
         FROM shipments
        WHERE tracking_number = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [trackingNumber],
      { name: 'carrier.shipmentByTracking' },
    )
  },
}
