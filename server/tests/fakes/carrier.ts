/**
 * A courier that exists only in tests (§20.3).
 *
 * ── Why this is a fake and not a `simulated` provider in `src/` ──────────────
 *
 * Because a provider shipped in the build is a provider somebody can configure,
 * and a courier that invents tracking numbers and confirms deliveries that
 * never happened is not something a shop should be one environment variable
 * away from running. The seam's honest production default is `manual` — no
 * courier connected — and it stays the only one until a real integration is
 * written.
 *
 * What this fake exists for is the other half: proving that the call sites do
 * the right thing when a courier *is* connected, including when it is slow,
 * refuses, or lies. Every knob below is there because some test needs the
 * courier to misbehave in a specific way.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  CarrierBooking,
  CarrierBookingRequest,
  CarrierCapabilities,
  CarrierProvider,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierRemittanceLine,
  CarrierShipmentStatus,
  CarrierTrackingEvent,
  CarrierTrackingUpdate,
} from '../../src/infrastructure/carriers/index.js'

export const FAKE_WEBHOOK_SECRET = 'fake-courier-signing-secret'

export interface FakeCarrierOptions {
  capabilities?: Partial<CarrierCapabilities>
  /** What `quote` returns. An empty array means "not to that address". */
  quotes?: CarrierQuote[]
  /** Milliseconds to stall, for exercising the timeouts. */
  delayMs?: number
  /** Set to make the next call of that method throw. */
  failNext?: Set<'quote' | 'book' | 'track'>
}

export class FakeCarrierProvider implements CarrierProvider {
  readonly name = 'fake'
  readonly label = 'Fake Courier'
  readonly capabilities: CarrierCapabilities

  /** Every call, in order, so a test can assert the shop did not ask twice. */
  readonly calls: string[] = []
  /** Booking requests as received, for asserting on weights and COD amounts. */
  readonly booked: CarrierBookingRequest[] = []
  /** Tracking answers, keyed by tracking number. */
  readonly tracking = new Map<string, CarrierTrackingEvent[]>()
  /** Lines the next `parseRemittance` returns. */
  remittance: CarrierRemittanceLine[] = []

  private counter = 0

  constructor(private readonly options: FakeCarrierOptions = {}) {
    this.capabilities = {
      quotes: true,
      booking: true,
      tracking: true,
      remittance: true,
      ...options.capabilities,
    }
  }

  private async gate(method: 'quote' | 'book' | 'track'): Promise<void> {
    this.calls.push(method)
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs))
    if (this.options.failNext?.has(method)) {
      this.options.failNext.delete(method)
      throw new Error(`fake courier refused to ${method}`)
    }
  }

  async quote(_request: CarrierQuoteRequest): Promise<CarrierQuote[]> {
    await this.gate('quote')
    return this.options.quotes ?? []
  }

  async book(request: CarrierBookingRequest): Promise<CarrierBooking> {
    await this.gate('book')
    this.booked.push(request)
    this.counter += 1
    const trackingNumber = `FAKE${String(this.counter).padStart(6, '0')}`
    return {
      trackingNumber,
      trackingUrl: `https://fake.example/track/${trackingNumber}`,
      consignmentId: `CN-${trackingNumber}`,
      label: null,
      amountCents: 50_00,
    }
  }

  async track(trackingNumber: string): Promise<CarrierTrackingUpdate> {
    await this.gate('track')
    return { trackingNumber, events: this.tracking.get(trackingNumber) ?? [] }
  }

  /**
   * Verifies exactly as a real provider must, so the route's contract — "the
   * provider is the authentication" — is actually exercised rather than assumed.
   */
  parseWebhook(
    raw: Buffer,
    headers: Record<string, string | undefined>,
  ): CarrierTrackingUpdate | null {
    const provided = headers['x-fake-signature']
    if (!provided) throw new Error('missing signature')

    const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(raw).digest('hex')
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature')

    const body = JSON.parse(raw.toString('utf8')) as {
      trackingNumber?: string
      events?: { status: string; description: string; at: string; raw?: string }[]
    }
    if (!body.trackingNumber || !body.events?.length) return null

    return {
      trackingNumber: body.trackingNumber,
      events: body.events.map((event) => ({
        status: event.status as CarrierShipmentStatus,
        description: event.description,
        location: null,
        occurredAt: new Date(event.at),
        rawStatus: event.raw ?? null,
      })),
    }
  }

  async parseRemittance(file: Buffer, _filename: string): Promise<CarrierRemittanceLine[]> {
    if (file.toString('utf8').startsWith('NOT-A-STATEMENT')) {
      throw new Error('unreadable')
    }
    return this.remittance
  }
}

/** Signs a body the way `FakeCarrierProvider.parseWebhook` expects. */
export function signFakeWebhook(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body)
  return {
    raw,
    signature: createHmac('sha256', FAKE_WEBHOOK_SECRET).update(raw).digest('hex'),
  }
}
