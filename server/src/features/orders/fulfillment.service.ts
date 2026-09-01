/**
 * Staff operations against a placed order (§5.7–5.8).
 *
 * Payments, refunds and shipments all *belong to* an order, but the payments
 * and shipping features must not import orders — so the wiring lives here, on
 * the orders side, exactly as `checkout.service.ts` does for placing one.
 *
 * The pattern in each case is the same: the other feature owns its own table,
 * its own concurrency guard and its own events, and takes a small set of hooks
 * for the parts only an order knows — what is owed, which line may be shipped,
 * what happens once the money moves.
 */
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import { DomainRuleError, ERROR_CODES } from '../../shared/errors/index.js'
import { paymentsService, type PaymentMethod, type Refund } from '../payments/index.js'
import { shippingService, type ShipmentStatus } from '../shipping/index.js'
import { ordersRepository as repo } from './orders.repository.js'
import { ordersService } from './orders.service.js'

const log = createLogger('orders.fulfillment')

export const fulfillmentService = {
  // ── Money in ──────────────────────────────────────────────────────────────

  /**
   * Records a payment against an order.
   *
   * The amount is the order's outstanding balance, computed by the payments
   * service from the order's own total — the request says *how* it was paid,
   * never *how much*. Settling the balance confirms the order, which is the
   * moment the reserved stock is actually committed.
   */
  async recordPayment(
    orderId: string,
    input: {
      method?: PaymentMethod
      provider?: string
      providerPaymentId?: string | null
      idempotencyKey?: string | null
      amountCents?: number
    },
    actor: Actor | null,
  ) {
    const order = await ordersService.getRaw(orderId)
    if (order.status === 'cancelled') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'A cancelled order cannot take a payment',
      )
    }

    return paymentsService.record(
      {
        orderId,
        ...input,
        // The order already knows how it was meant to be paid; defaulting to it
        // keeps the payment row honest about a COD collection.
        method: input.method ?? (order.paymentMethod as PaymentMethod),
      },
      {
        order: {
          totalCents: order.totalCents,
          refundedTotalCents: order.refundedTotalCents,
          currency: order.currency,
          orderNumber: order.orderNumber,
          email: order.email,
        },
        actor,
        // Called only when the balance reaches zero. Confirming here rather
        // than on placement is what makes an unpaid order releasable.
        onPaid: async () => {
          await ordersService.transition(orderId, 'payment_status', 'paid', {
            actorUserId: actor?.userId ?? null,
            actorType: actor ? 'staff' : 'system',
          })
          if (order.status === 'pending') {
            await ordersService.confirm(orderId, actor, actor ? 'staff' : 'system')
          }
        },
      },
    )
  },

  // ── Money out ─────────────────────────────────────────────────────────────

  /**
   * Refunds part or all of a payment and reflects it on the order.
   *
   * The payments service enforces "never more than was captured" with a
   * conditional UPDATE; this adds the order-level consequences: the running
   * refunded total, the payment status, and — if asked — putting the goods back
   * on the shelf with an explicit `return` movement rather than a silent bump.
   */
  async refund(
    orderId: string,
    input: {
      paymentId: string
      amountCents: number
      reason?: string | null
      restock?: boolean
      idempotencyKey?: string | null
      /** The units coming back. Required by the schema whenever restocking. */
      items?: { orderItemId: string; quantity: number }[]
    },
    actor: Actor,
  ): Promise<Refund> {
    const order = await ordersService.getRaw(orderId)
    const payment = await paymentsService.getById(input.paymentId)
    if (payment.orderId !== orderId) {
      // Refusing rather than 404ing on the payment keeps the two ids from being
      // used to probe which payments exist.
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That payment does not belong to this order',
      )
    }

    return paymentsService.refund(input, {
      actor,
      order: { orderNumber: order.orderNumber, email: order.email },
      onRefunded: async (refund) => {
        await repo.addRefundedTotal(orderId, refund.amountCents)

        // Re-read rather than adding to the value fetched at the top of this
        // method. Two refunds issued at the same moment both start from the
        // same stale figure, and each would then conclude the order was only
        // *partially* refunded — leaving an order that is fully refunded in
        // money but not in status. The increment above is atomic; this reads
        // back what it actually produced.
        const refundedTotal = await repo.refundedTotal(orderId)
        await ordersService.transition(
          orderId,
          'payment_status',
          refundedTotal >= order.totalCents ? 'refunded' : 'partially_refunded',
          { actorUserId: actor.userId, actorType: 'staff', reason: refund.reason ?? null },
        )

        // Only the units named in the request, never the whole line.
        //
        // This used to call `restock()`, which returns everything the order
        // still holds — so a one-pound goodwill refund on a three-unit line
        // put all three units back on the shelf and the shop then sold stock
        // it did not have.
        //
        // The named units are recorded as refunded whether or not they go back
        // on the shelf: `refunded_quantity` is what "how much of this line is
        // still refundable" is measured against, and a refund that skipped the
        // counter because nothing was restocked left that question answerable
        // twice over.
        if (input.items && input.items.length > 0) {
          await ordersService.recordRefundedUnits(orderId, input.items, actor, {
            restock: refund.restock,
          })
        }
        log.info({ orderId, refundId: refund.id, restock: refund.restock }, 'order refunded')
      },
    })
  },

  /**
   * What is still refundable, per line and in total.
   *
   * The refund endpoint enforces three separate limits, and this reports all
   * three rather than a single number, because a dialog that offers a figure
   * the server will then refuse is worse than no figure at all:
   *
   *   • a payment cannot be refunded beyond what it captured
   *   • a line cannot be refunded beyond the units ordered
   *   • an order cannot be refunded beyond its own total
   *
   * The per-unit figure is the line's **total** divided by its quantity — what
   * the customer actually paid for one unit after its share of the discount and
   * its tax — not the list price. Refunding the list price on a discounted line
   * hands back money that never arrived.
   *
   * Shipping is reported but not tracked as refunded-or-not. Nothing records
   * which refund covered postage, and inventing that record to answer a
   * question nobody has asked would be a second copy of the truth. The
   * order-level cap is what stops it being refunded twice.
   */
  async refundable(orderId: string) {
    const order = await ordersService.getRaw(orderId)
    const [items, payments] = await Promise.all([
      repo.items(orderId),
      paymentsService.listForOrder(orderId),
    ])

    const refundablePayments = payments
      .filter((payment) => payment.status === 'paid' || payment.status === 'partially_refunded')
      .map((payment) => ({
        id: payment.id,
        method: payment.method,
        refundable: payment.amountCents - payment.refundedCents,
      }))
      .filter((payment) => payment.refundable > 0)

    const onPayments = refundablePayments.reduce((sum, payment) => sum + payment.refundable, 0)
    const onOrder = order.totalCents - order.refundedTotalCents

    return {
      currency: order.currency,
      // The binding limit, whichever it is. Both are real; the smaller one is
      // what the next request will actually be allowed to do.
      maxRefundableCents: Math.max(0, Math.min(onPayments, onOrder)),
      shippingTotalCents: order.shippingTotalCents,
      payments: refundablePayments,
      lines: items.map((item) => {
        const refundableQuantity = Math.max(0, item.quantity - item.refundedQuantity)
        // Integer division, and the remainder stays with the shop rather than
        // rounding a penny into existence on every unit.
        const perUnit = Math.floor(item.totalCents / item.quantity)
        return {
          orderItemId: item.id,
          productTitle: item.productTitle,
          variantTitle: item.variantTitle,
          sku: item.sku,
          quantity: item.quantity,
          refundedQuantity: item.refundedQuantity,
          refundableQuantity,
          perUnitCents: perUnit,
          lineRefundableCents: perUnit * refundableQuantity,
        }
      }),
    }
  },

  // ── Goods out ─────────────────────────────────────────────────────────────

  /**
   * Ships some or all of an order's lines.
   *
   * Partial shipment is normal, so the fulfilment status is *derived* from what
   * has actually gone rather than being set by whoever clicked the button.
   */
  async createShipment(
    orderId: string,
    input: {
      items: { orderItemId: string; quantity: number }[]
      carrier?: string | null
      service?: string | null
      trackingNumber?: string | null
      trackingUrl?: string | null
    },
    actor: Actor,
  ) {
    const order = await ordersService.getRaw(orderId)
    if (order.status === 'cancelled') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'A cancelled order cannot be shipped',
      )
    }

    const items = await repo.items(orderId)
    for (const line of input.items) {
      if (!items.some((item) => item.id === line.orderItemId)) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          'That line does not belong to this order',
        )
      }
    }

    return shippingService.createShipment({ orderId, ...input }, actor, {
      order: { email: order.email, orderNumber: order.orderNumber },
      incrementFulfilled: (orderItemId, quantity) => repo.incrementFulfilled(orderItemId, quantity),
      afterShipment: (id) => this.syncFulfillmentStatus(id, actor),
    })
  },

  async setShipmentStatus(shipmentId: string, status: ShipmentStatus, actor: Actor) {
    const shipment = await shippingService.getShipment(shipmentId)
    const order = await ordersService.getRaw(shipment.orderId)

    const updated = await shippingService.setShipmentStatus(shipmentId, status, actor, {
      order: { orderId: order.id, orderNumber: order.orderNumber, email: order.email },
    })

    // A delivered shipment only marks the *order* delivered when nothing is
    // still outstanding — two parcels, one delivered, is not a delivered order.
    if (status === 'delivered' && order.fulfillmentStatus === 'fulfilled') {
      await ordersService.transition(order.id, 'fulfillment_status', 'delivered', {
        actorUserId: actor.userId,
        actorType: 'staff',
      })
    }
    return updated
  },

  async listShipments(orderId: string) {
    return shippingService.listForOrder(orderId)
  },

  /**
   * Recomputes fulfilment from the lines.
   *
   * Derived, never asserted: the alternative is a status field that has to be
   * kept in step by every caller and eventually is not.
   */
  async syncFulfillmentStatus(orderId: string, actor: Actor | null): Promise<void> {
    const items = await repo.items(orderId)
    const shippable = items.filter((item) => item.requiresShipping)
    if (shippable.length === 0) return

    const allShipped = shippable.every((item) => item.fulfilledQuantity >= item.quantity)
    const anyShipped = shippable.some((item) => item.fulfilledQuantity > 0)
    const target = allShipped ? 'fulfilled' : anyShipped ? 'partially_fulfilled' : null
    if (!target) return

    await ordersService.transition(orderId, 'fulfillment_status', target, {
      actorUserId: actor?.userId ?? null,
      actorType: actor ? 'staff' : 'system',
    })

    // A fully shipped and fully paid order has nothing left to do.
    const order = await ordersService.getRaw(orderId)
    if (allShipped && order.paymentStatus === 'paid' && order.status === 'processing') {
      await ordersService.transition(orderId, 'status', 'completed', {
        actorUserId: actor?.userId ?? null,
        actorType: actor ? 'staff' : 'system',
      })
    }
  },

  async payments(orderId: string) {
    return paymentsService.listForOrder(orderId)
  },

  async refunds(orderId: string) {
    return paymentsService.listRefundsForOrder(orderId)
  },
}

export function outstandingFor(orderId: string, totalCents: number): Promise<number> {
  return paymentsService.outstandingFor(orderId, totalCents)
}
