/**
 * `shipping.poll_tracking` — asking the courier where the parcels are.
 *
 * ── Why poll at all when webhooks exist ──────────────────────────────────────
 *
 * Because most couriers do not have them, and the ones that do miss deliveries.
 * A shop whose orders only advance when a webhook arrives has orders that sit
 * in "shipped" for ever the first time a callback is dropped, and nobody
 * notices until a customer asks. Polling is the floor; a webhook, where one
 * exists, makes it fast.
 *
 * Both paths converge on `applyTracking` below, so a scan recorded either way
 * produces the same state and the same emails — and the uniqueness constraint
 * on the events table means a parcel seen twice is recorded once.
 *
 * ── What it costs ────────────────────────────────────────────────────────────
 *
 * One request per parcel still moving. Delivered, returned and failed parcels
 * are excluded, so the cost is proportional to open shipments rather than to
 * the shop's history — a shop that has shipped ten thousand parcels and has
 * twelve open asks about twelve.
 */
import { carrierService } from '../../features/shipping/carrier.service.js'
import { shippingService } from '../../features/shipping/index.js'
import { ordersService } from '../../features/orders/index.js'
import { getCarrier } from '../../infrastructure/carriers/index.js'
import type { CarrierTrackingEvent } from '../../infrastructure/carriers/index.js'
import type { JobContext } from '../../infrastructure/queue/index.js'

export interface PollTrackingPayload {
  batchSize: number
}

export async function pollTrackingHandler(
  payload: PollTrackingPayload,
  ctx: JobContext,
): Promise<void> {
  const carrier = getCarrier()
  if (!carrier.capabilities.tracking) return

  const parcels = await carrierService.inFlight(payload.batchSize)
  if (parcels.length === 0) return

  let advanced = 0

  for (const parcel of parcels) {
    const update = await carrierService.track(parcel.trackingNumber)
    // Null means the courier could not be reached or had nothing. Neither is a
    // reason to stop asking about the other parcels.
    if (!update) continue

    const changed = await applyTracking(parcel.id, carrier.name, update.events)
    if (changed) advanced += 1
  }

  ctx.logger.info(
    { checked: parcels.length, advanced, provider: carrier.name },
    'tracking polled',
  )
}

/**
 * Records scans and moves the shipment on if the courier says it has moved.
 *
 * Shared by the poll and the webhook, so there is one answer to "what does a
 * scan do" rather than two that drift.
 *
 * ── The status is the newest scan's, not the highest ─────────────────────────
 *
 * Parcels go backwards. A failed delivery attempt after an "out for delivery"
 * scan is a real thing that happens, and a shop that only ever moved a shipment
 * forwards would show "delivered" for a parcel sitting at a depot. So the
 * latest event by the courier's own clock wins.
 *
 * The transition still goes through `shippingService.setShipmentStatus`, which
 * owns the emails and the order-level fulfilment rules — a scan is an input to
 * that, never a way around it.
 */
export async function applyTracking(
  shipmentId: string,
  provider: string,
  events: CarrierTrackingEvent[],
): Promise<boolean> {
  const recorded = await carrierService.recordEvents(shipmentId, provider, events)
  if (recorded.length === 0) return false

  const latest = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  )[events.length - 1]
  if (!latest) return false

  const shipment = await shippingService.getShipment(shipmentId)
  if (shipment.status === latest.status) return true

  /**
   * The courier acts as the system, not as a member of staff.
   *
   * There is no person behind a scan, so the audit trail must not name one.
   * A null actor is what distinguishes "the courier told us" from
   * "somebody in the warehouse decided", which is exactly the distinction
   * anybody reading the trail later needs.
   */
  await shippingService.setShipmentStatus(shipmentId, latest.status, null, {
    order: await orderContext(shipment.orderId),
  })

  return true
}

async function orderContext(orderId: string) {
  const order = await ordersService.getRaw(orderId)
  return { orderId: order.id, orderNumber: order.orderNumber, email: order.email }
}
