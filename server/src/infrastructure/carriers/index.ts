/**
 * Courier selection happens once, here.
 *
 * Nothing else in the codebase knows which courier is active — the rule the
 * email and storage subsystems already follow. A feature calls `getCarrier()`
 * and gets a `CarrierProvider`.
 *
 * ── Adding a courier ─────────────────────────────────────────────────────────
 *
 *   1. Write `providers/<name>.ts` implementing `CarrierProvider`.
 *   2. Declare only the capabilities it genuinely has.
 *   3. Add it to `build()` below and to `CARRIER_PROVIDERS`.
 *   4. Add its credentials to the environment schema.
 *
 * Nothing in shipping, orders or the storefront changes. That is the whole
 * point of the seam.
 */
import { env } from '../../config/index.js'
import { createLogger } from '../logging/logger.js'
import { ManualCarrierProvider } from './providers/manual.js'
import type { CarrierProvider } from './provider.js'

const log = createLogger('carrier')

/** Every courier this build knows how to talk to. */
export const CARRIER_PROVIDERS = ['manual'] as const
export type CarrierName = (typeof CARRIER_PROVIDERS)[number]

let provider: CarrierProvider | undefined

function build(): CarrierProvider {
  switch (env.CARRIER_PROVIDER) {
    case 'manual':
    default:
      return new ManualCarrierProvider()
  }
}

/**
 * Refuses a provider that promises what it cannot do.
 *
 * A capability flag is read by the admin to decide which buttons to show and by
 * the services to decide whether to call out at all. A provider declaring
 * `booking: true` with no `book` method would therefore fail at the one moment
 * that matters — a parcel waiting to go out — so it fails at startup instead.
 */
function assertHonest(candidate: CarrierProvider): void {
  const missing: string[] = []
  if (candidate.capabilities.quotes && !candidate.quote) missing.push('quote')
  if (candidate.capabilities.booking && !candidate.book) missing.push('book')
  if (candidate.capabilities.tracking && !candidate.track && !candidate.parseWebhook) {
    missing.push('track or parseWebhook')
  }
  if (candidate.capabilities.remittance && !candidate.parseRemittance) {
    missing.push('parseRemittance')
  }

  if (missing.length > 0) {
    throw new Error(
      `Carrier provider "${candidate.name}" declares capabilities it does not implement: ${missing.join(', ')}`,
    )
  }
}

export function getCarrier(): CarrierProvider {
  if (!provider) {
    const candidate = build()
    assertHonest(candidate)
    provider = candidate
    log.debug(
      { provider: provider.name, capabilities: provider.capabilities },
      'carrier provider selected',
    )
  }
  return provider
}

/** Test seam: substitute a provider, or reset to the configured one. */
export function setCarrier(next: CarrierProvider | undefined): void {
  if (next) assertHonest(next)
  provider = next
}

export type {
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
} from './provider.js'
export { ManualCarrierProvider } from './providers/manual.js'
