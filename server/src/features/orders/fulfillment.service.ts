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
import { carrierService } from '../shipping/carrier.service.js'
import { codService } from '../shipping/cod.service.js'
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

    /**
     * Ask the courier to take it, if one is connected.
     *
     * ── Before the shipment row, on purpose ──────────────────────────────────
     *
     * A booking that fails must leave nothing behind: no shipment, no
     * incremented fulfilled counts, no parcel the system believes has gone. So
     * the courier is called first and its refusal propagates — the operator is
     * told the booking failed and can try again, rather than being left with a
     * shipment that looks real and a courier that has never heard of it.
     *
     * ── What the courier says beats what was typed ───────────────────────────
     *
     * The tracking number it returns is authoritative: it is the number the
     * courier will actually answer to. Anything the operator typed is a guess
     * at best. With no courier connected, `book` returns null and what they
     * typed is all there is — which is exactly the shop as it worked before.
     */
    const booking = await this.bookWithCarrier(order, input)

    const shipment = await shippingService.createShipment(
      {
        orderId,
        ...input,
        ...(booking
          ? {
              trackingNumber: booking.trackingNumber,
              trackingUrl: booking.trackingUrl ?? input.trackingUrl ?? null,
            }
          : {}),
      },
      actor,
      {
        order: { email: order.email, orderNumber: order.orderNumber },
        incrementFulfilled: (orderItemId, quantity) =>
          repo.incrementFulfilled(orderItemId, quantity),
        afterShipment: (id) => this.syncFulfillmentStatus(id, actor),
      },
    )

    if (booking) {
      await carrierService.attachBooking(shipment.id, carrierService.capabilities().provider, booking)
    }

    return shipment
  },

  /**
   * Turns an order into the consignment a courier wants.
   *
   * Returns null when no courier is connected or it cannot book, which is the
   * signal to carry on exactly as before.
   */
  async bookWithCarrier(
    order: Awaited<ReturnType<typeof ordersService.getRaw>>,
    input: { items: { orderItemId: string; quantity: number }[]; service?: string | null },
  ) {
    if (!carrierService.capabilities().booking) return null

    const detail = await ordersService.detail(order.id)
    const shipping = detail.addresses.find((address) => address.type === 'shipping')
    if (!shipping) return null

    const shipped = new Map(input.items.map((item) => [item.orderItemId, item.quantity]))
    const lines = detail.items.filter((item) => shipped.has(item.id))

    const contents = lines.map((item) => ({
      description: item.variantTitle
        ? `${item.productTitle} — ${item.variantTitle}`
        : item.productTitle,
      quantity: shipped.get(item.id) ?? item.quantity,
    }))

    // The weight of what is *in this parcel*, not of the whole order: a partial
    // shipment is a smaller box, and a courier that quotes on the order's full
    // weight overcharges for every one of them.
    const weightGrams = lines.reduce(
      (total, item) => total + item.weightGrams * (shipped.get(item.id) ?? 0),
      0,
    )
    const valueCents = lines.reduce(
      (total, item) => total + item.unitPriceCents * (shipped.get(item.id) ?? 0),
      0,
    )

    return carrierService.book({
      orderNumber: order.orderNumber,
      serviceCode: input.service ?? null,
      recipient: {
        name: `${shipping.firstName} ${shipping.lastName}`.trim(),
        phone: shipping.phone ?? detail.phone,
        email: detail.email,
        line1: shipping.line1,
        line2: shipping.line2,
        city: shipping.city,
        region: shipping.region,
        postalCode: shipping.postalCode,
        countryCode: shipping.countryCode,
      },
      parcel: {
        weightGrams,
        contents,
        valueCents,
        currency: order.currency,
      },
      /**
       * Only a genuinely unpaid cash-on-delivery order asks the courier to
       * collect. Sending a non-zero amount for an order already paid by card is
       * how a customer is charged twice at their own front door.
       */
      codAmountCents:
        order.paymentMethod === 'cod' && order.paymentStatus !== 'paid' ? order.totalCents : 0,
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

  // ── Money in, by way of the courier ───────────────────────────────────────

  /**
   * Imports a courier's cash-on-delivery statement.
   *
   * The wiring the COD service cannot do for itself: it owns the statement and
   * the matching, and asks here what each order is actually owed, because
   * shipping does not know about orders and must not learn.
   *
   * Nothing is marked paid. See `settleCodLine`.
   */
  async importCodRemittance(
    input: {
      file: Buffer
      filename: string
      reference?: string | null
      statementDate?: Date | null
      declaredNetCents?: number | null
      currency?: string | null
    },
    actor: Actor,
  ) {
    return codService.import(input, { outstandingFor: codOrderLookup }, actor)
  },

  /**
   * Records the cash for one reconciled line.
   *
   * ── Why one line at a time ────────────────────────────────────────────────
   *
   * Because each one confirms an order and commits its stock, and a "settle
   * everything" button over a parsed spreadsheet is precisely the destructive
   * bulk action that should not exist. The admin may loop over the matched
   * lines; every iteration is still a decision the server checked.
   *
   * ── Why only matched lines ────────────────────────────────────────────────
   *
   * A mismatched line is the finding, not a rounding error to wave through: the
   * courier says it collected an amount the order does not agree with, and
   * somebody has to decide which is right. They can still record a payment on
   * the order directly — with their own name against it — which is exactly the
   * accountability that settling from here would launder away.
   */
  async settleCodLine(lineId: string, actor: Actor) {
    const line = await codService.getLine(lineId)

    if (line.settled) {
      throw new DomainRuleError(
        ERROR_CODES.PAYMENT_ALREADY_SETTLED,
        'That line has already been recorded against the order',
      )
    }
    if (!line.orderId) {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        'That line does not name an order of ours',
      )
    }
    if (line.matchStatus !== 'matched') {
      throw new DomainRuleError(
        ERROR_CODES.DOMAIN_RULE_VIOLATION,
        line.matchStatus === 'mismatched'
          ? 'The courier collected a different amount from what this order is owed — record the payment on the order itself, so the difference is somebody’s decision'
          : 'That line could not be matched to an order',
      )
    }

    /*
     * `provider: 'carrier'` with the line id as the provider payment id.
     *
     * That pair is what `settled` is read back from, so the same line cannot be
     * banked twice — and it is what lets anybody looking at a payment six
     * months later find the statement it came off.
     */
    const payment = await this.recordPayment(
      line.orderId,
      {
        method: 'cod',
        provider: 'carrier',
        providerPaymentId: line.id,
        amountCents: line.collectedCents,
      },
      actor,
    )

    log.info(
      { lineId, orderId: line.orderId, amountCents: line.collectedCents },
      'cod line settled',
    )
    return payment
  },
}

/**
 * What an order is owed, for the matcher.
 *
 * Returns null rather than throwing for an order that no longer exists: a
 * statement naming a deleted order is a finding to display, not a reason to
 * abandon the import of the ninety-nine lines around it.
 */
async function codOrderLookup(orderId: string) {
  try {
    const order = await ordersService.getRaw(orderId)
    const outstandingCents = await paymentsService.outstandingFor(
      orderId,
      order.totalCents - order.refundedTotalCents,
    )
    return { outstandingCents, currency: order.currency, orderNumber: order.orderNumber }
  } catch {
    return null
  }
}

export function outstandingFor(orderId: string, totalCents: number): Promise<number> {
  return paymentsService.outstandingFor(orderId, totalCents)
}
