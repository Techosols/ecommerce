/**
 * Orders and checkout (§5.6, CLAUDE.md §16–18).
 *
 * ── What checkout actually guarantees ───────────────────────────────────────
 *
 * One transaction turns a cart into an order. Inside it, in this order:
 *
 *   1. re-resolve the cart against the live catalogue — prices are read now,
 *      never taken from the client and never trusted from the cart
 *   2. reserve every line's stock, which either succeeds for all of them or
 *      fails and rolls everything back
 *   3. snapshot each line into `order_items`, so renaming or repricing a
 *      product tomorrow cannot rewrite what someone bought today
 *   4. copy the addresses, for the same reason
 *   5. mark the cart converted
 *
 * If any step fails there is no order, no reservation and no charge. That is
 * the whole point of doing it in one transaction rather than in five steps a
 * customer can abandon between.
 *
 * ── Three status machines ───────────────────────────────────────────────────
 *
 * `status`, `payment_status` and `fulfillment_status` move independently, each
 * through its own validated transitions. The flat vocabulary CLAUDE.md §17 asks
 * for is derived for display and never stored.
 */
import { v7 as uuidv7 } from 'uuid'
import { publish } from '../../events/index.js'
import { withTransaction } from '../../infrastructure/database/transaction.js'
import { createLogger } from '../../infrastructure/logging/logger.js'
import type { Actor } from '../../shared/auth/actor.js'
import {
  ConflictError,
  DomainRuleError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js'
import { auditService } from '../audit/index.js'
import { cartsService } from '../carts/index.js'
import type { ResolvedCart } from '../carts/index.js'
import { customersService } from '../customers/index.js'
import { inventoryService, reservationsService } from '../inventory/index.js'
import { paymentsService } from '../payments/index.js'
import { shippingService } from '../shipping/index.js'
import { settingsService, taxAddedTo } from '../settings/index.js'
import { ordersRepository as repo } from './orders.repository.js'
import type {
  CheckoutInput,
  DisplayStatus,
  FulfillmentStatus,
  Order,
  OrderDetail,
  OrderListFilter,
  OrderNote,
  OrderStatus,
  PaymentStatus,
  TimelineEntry,
} from './orders.types.js'

const log = createLogger('orders')

/**
 * Legal moves for each machine. A transition that is not here cannot happen,
 * which is what stops a cancelled order quietly becoming completed.
 */
const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // A draft leaves by being *placed*, which is a different operation from a
  // status change: placing reserves stock, assigns the moment of sale and
  // fires the same events a storefront checkout does. Listing `pending` here
  // would offer a plain status update that skipped all three.
  draft: [],
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['authorized', 'paid', 'failed', 'cancelled'],
  authorized: ['paid', 'failed', 'cancelled'],
  paid: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
  failed: ['pending', 'authorized', 'paid'],
  cancelled: [],
}

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  unfulfilled: ['partially_fulfilled', 'fulfilled'],
  partially_fulfilled: ['partially_fulfilled', 'fulfilled'],
  fulfilled: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
}

/**
 * The flat status CLAUDE.md §17 asks for, derived from the three real ones.
 *
 * Derived rather than stored: a fourth column that must agree with three others
 * is a fourth column that will eventually disagree.
 */
export function displayStatus(order: Order): DisplayStatus {
  if (order.status === 'cancelled') return 'cancelled'
  if (order.fulfillmentStatus === 'returned') return 'returned'
  if (order.fulfillmentStatus === 'delivered') return 'delivered'
  if (order.status === 'completed') return 'completed'
  if (order.fulfillmentStatus === 'fulfilled' || order.fulfillmentStatus === 'partially_fulfilled') {
    return 'shipped'
  }
  if (order.status === 'processing') return 'processing'
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'authorized') return 'confirmed'
  return 'pending'
}

export const ordersService = {
  // ── Checkout ──────────────────────────────────────────────────────────────

  /**
   * Turns a cart into an order.
   *
   * Everything monetary is computed here from the catalogue, so the request
   * body carries an address and a choice of shipping method — never a price,
   * never a total, never a line amount.
   */
  async checkout(
    input: CheckoutInput,
    context: {
      customerId: string | null
      source?: 'storefront' | 'admin'
      actor?: Actor | null
      /**
       * A basket that is not a cart — the lines of a draft order.
       *
       * Supplied instead of resolving `input.cartId`, so a draft runs the
       * whole of checkout: the same pricing, the same reservation inside the
       * same transaction, the same events. Nothing about placement is
       * reimplemented for staff.
       */
      basket?: ResolvedCart
      quoteShipping?: (args: {
        countryCode: string
        subtotalCents: number
        weightGrams: number
        methodId: string | null
      }) => Promise<{ methodId: string | null; name: string | null; amountCents: number }>
      applyDiscount?: (args: {
        code: string
        subtotalCents: number
        customerId: string | null
        lines: { productId: string; lineTotalCents: number }[]
      }) => Promise<{
        discountId: string
        code: string
        type: string
        value: number
        amountCents: number
        freeShipping: boolean
      }>
      /**
       * Consumes the code's usage, called *inside* the checkout transaction so
       * that a code with one use left cannot be spent by two simultaneous
       * checkouts: the loser's conditional UPDATE affects no rows and its whole
       * order rolls back.
       */
      redeemDiscount?: (args: {
        discountId: string
        orderId: string
        customerId: string | null
        amountCents: number
      }) => Promise<void>
      /**
       * Validates the chosen payment method against this basket and returns
       * its surcharge. Injected for the same reason shipping and discounts are:
       * orders must not import payments, and the method rules belong with the
       * payments feature that owns them.
       */
      resolvePaymentMethod?: (args: {
        method: string
        subtotalCents: number
        countryCode: string
        customerId: string | null
        requiresShipping: boolean
      }) => Promise<{ key: string; feeCents: number }>
      /**
       * Creates the customer record for a first-time guest, called *inside*
       * the checkout transaction and only once everything else has passed.
       *
       * That placement is the whole point. Creating the record up front meant
       * every abandoned checkout — a missing delivery option, an expired code,
       * a basket that went out of stock while they typed — left a customer
       * behind who had never bought anything. In here it rolls back with the
       * order, so a customer record means an order exists.
       *
       * Only called when `customerId` is still null: a returning guest was
       * already recognised by email before any of the per-customer rules ran,
       * which is what lets those rules apply to them.
       */
      ensureCustomer?: () => Promise<string>
    },
  ): Promise<OrderDetail> {
    const settings = await settingsService.get()

    /**
     * The basket being bought.
     *
     * Normally a cart, resolved here. A draft order supplies its own — the
     * lines a staff member assembled by hand — and everything downstream is
     * identical, which is the point: a draft and a storefront checkout price,
     * reserve and record through one implementation rather than two that drift.
     */
    const cart = context.basket ?? (await cartsService.resolve(input.cartId))

    // Only a real cart can be stale; a hand-built basket has no such state.
    if (!context.basket && cart.cart.status !== 'active') {
      throw new ConflictError('This cart has already been checked out', {
        code: ERROR_CODES.DOMAIN_RULE_VIOLATION,
      })
    }
    if (cart.lines.length === 0) throw new ValidationError('The cart is empty')
    if (!cart.purchasable) {
      // Naming the offending lines matters: "checkout failed" sends a customer
      // back to a page that looks fine.
      const problems = cart.lines
        .filter((line) => !line.purchasable)
        .map((line) => `${line.productTitle}: ${line.problem}`)
      throw new DomainRuleError(
        ERROR_CODES.INSUFFICIENT_STOCK,
        `Some items are no longer available — ${problems.join('; ')}`,
      )
    }
    /**
     * Who is buying.
     *
     * Starts as whoever the caller identified — a signed-in shopper, or a
     * returning guest the storefront recognised by email — and stays null for
     * a first-time guest until `ensureCustomer` runs inside the transaction
     * below. Everything from here on reads this rather than `context`, so the
     * order is written against whoever it ends up belonging to.
     */
    let customerId = context.customerId

    if (customerId) {
      await customersService.assertCanOrder(await customersService.getById(customerId))
    }

    const subtotal = cart.totals.subtotal.amount
    const weight = cart.lines.reduce((sum, line) => sum + line.weightGrams * line.quantity, 0)
    const needsShipping = cart.lines.some((line) => line.requiresShipping)

    // ── Money, computed server-side, in this order ────────────────────────
    let discount = { discountId: null as string | null, code: '', type: '', value: 0, amountCents: 0, freeShipping: false }
    if (input.discountCode && context.applyDiscount) {
      discount = await context.applyDiscount({
        code: input.discountCode,
        subtotalCents: subtotal,
        customerId: customerId,
        // The basket itself, so a product- or category-scoped code discounts
        // only the lines it actually covers.
        lines: cart.lines.map((line) => ({
          productId: line.productId,
          lineTotalCents: line.lineTotal.amount,
        })),
      })
    }

    let shipping = { methodId: null as string | null, name: null as string | null, amountCents: 0 }
    if (needsShipping && context.quoteShipping) {
      shipping = await context.quoteShipping({
        countryCode: input.shippingAddress.countryCode,
        subtotalCents: subtotal - discount.amountCents,
        weightGrams: weight,
        methodId: input.shippingMethodId ?? null,
      })
    }
    if (discount.freeShipping) shipping = { ...shipping, amountCents: 0 }

    const discountTotal = Math.min(discount.amountCents, subtotal)
    const taxable = subtotal - discountTotal
    const taxTotal = taxAddedTo(taxable, settings)

    // The payment method is re-validated here, against this basket and this
    // address, rather than trusted from the request: the offer the browser is
    // holding may be minutes old, and the store's COD policy may have changed
    // or the customer may have reached their open-order cap since.
    const payment = context.resolvePaymentMethod
      ? await context.resolvePaymentMethod({
          method: input.paymentMethod,
          subtotalCents: subtotal,
          countryCode: input.shippingAddress.countryCode,
          customerId: customerId,
          requiresShipping: needsShipping,
        })
      : { key: input.paymentMethod, feeCents: 0 }

    const total = subtotal - discountTotal + taxTotal + shipping.amountCents + payment.feeCents

    const orderId = uuidv7()
    const orderNumber = await repo.nextOrderNumber(settings.orderNumberPrefix)

    await withTransaction(async () => {
      // A first-time guest becomes a customer here and nowhere else. Inside
      // the transaction, so an order that fails to commit leaves no orphan
      // record; and before the insert, because the order references it.
      if (!customerId && context.ensureCustomer) {
        customerId = await context.ensureCustomer()
      }

      const order = await repo.create({
        id: orderId,
        orderNumber,
        customerId,
        email: input.email.toLowerCase(),
        phone: input.phone ?? null,
        currency: cart.cart.currency,
        subtotalCents: subtotal,
        discountTotalCents: discountTotal,
        taxTotalCents: taxTotal,
        shippingTotalCents: shipping.amountCents,
        paymentFeeCents: payment.feeCents,
        totalCents: total,
        paymentMethod: payment.key,
        shippingMethodId: shipping.methodId,
        shippingMethodName: shipping.name,
        customerNote: input.customerNote ?? null,
        source: context.source ?? 'storefront',
      })

      // Line discounts are apportioned by share of subtotal, so the parts add
      // up to the order-level figure exactly — the last line absorbs the
      // rounding remainder rather than leaving the order one penny off its own
      // CHECK constraint.
      let allocated = 0
      for (const [index, line] of cart.lines.entries()) {
        const isLast = index === cart.lines.length - 1
        const lineDiscount = isLast
          ? discountTotal - allocated
          : Math.round((line.lineTotal.amount / Math.max(subtotal, 1)) * discountTotal)
        allocated += lineDiscount

        const lineSubtotal = line.lineTotal.amount
        const lineTaxable = lineSubtotal - lineDiscount
        const lineTax = taxAddedTo(lineTaxable, settings)

        await repo.insertItem({
          id: uuidv7(),
          orderId,
          variantId: line.variantId,
          productId: line.productId,
          productTitle: line.productTitle,
          variantTitle: line.variantTitle,
          sku: line.sku,
          imageUrl: line.imageUrl,
          options: line.options,
          unitPriceCents: line.unitPrice.amount,
          quantity: line.quantity,
          subtotalCents: lineSubtotal,
          discountCents: lineDiscount,
          taxCents: lineTax,
          totalCents: lineSubtotal - lineDiscount + lineTax,
          requiresShipping: line.requiresShipping,
          weightGrams: line.weightGrams,
        })

        // Reserve inside the same transaction. If any line has run out since
        // the cart was resolved a moment ago, everything rolls back — no order,
        // no partial hold.
        //
        // The lifetime is the *order* window, not the cart one. A cart hold of
        // an hour is right for a basket somebody may abandon; on a placed order
        // it would lapse silently while the order still looked live, and the
        // same unit could then be sold twice. `orderReservationHours` is
        // deliberately longer than the sweep that cancels unpaid orders, so the
        // order is always cancelled before its stock is let go.
        await reservationsService.reserve(
          {
            variantId: line.variantId,
            quantity: line.quantity,
            ownerType: 'order',
            ownerId: orderId,
            expiresInMinutes: settings.orderReservationHours * 60,
          },
          context.actor ?? null,
        )
      }

      await repo.insertAddress({
        id: uuidv7(),
        orderId,
        type: 'shipping',
        ...input.shippingAddress,
      })
      await repo.insertAddress({
        id: uuidv7(),
        orderId,
        type: 'billing',
        ...(input.billingAddress ?? input.shippingAddress),
      })

      if (discount.discountId) {
        await repo.insertDiscount({
          id: uuidv7(),
          orderId,
          discountId: discount.discountId,
          code: discount.code,
          type: discount.type,
          value: discount.value,
          amountCents: discountTotal,
        })
        if (context.redeemDiscount) {
          await context.redeemDiscount({
            discountId: discount.discountId,
            orderId,
            customerId: customerId,
            amountCents: discountTotal,
          })
        }
      }

      await repo.recordStatusChange({
        orderId,
        field: 'status',
        fromValue: null,
        toValue: 'pending',
        actorUserId: customerId,
        actorType: context.source === 'admin' ? 'staff' : 'customer',
      })

      // A hand-built basket has no cart to convert.
      if (!context.basket) await cartsService.markConverted(input.cartId, orderId)

      await publish(
        'order.placed',
        {
          orderId,
          orderNumber,
          customerId: customerId,
          email: order.email,
          totalCents: total,
          currency: order.currency,
          itemCount: cart.totals.itemCount,
        },
        { aggregateId: orderId, actorUserId: customerId ?? undefined },
      )
    })

    log.info({ orderId, orderNumber, totalCents: total }, 'order placed')
    return this.detail(orderId)
  },

  // ── Reading ───────────────────────────────────────────────────────────────

  async detail(orderId: string): Promise<OrderDetail> {
    const order = await repo.findById(orderId)
    if (!order) throw new NotFoundError('Order not found')

    const [items, addresses, discounts] = await Promise.all([
      repo.items(orderId),
      repo.addresses(orderId),
      repo.discounts(orderId),
    ])
    return { ...order, items, addresses, discounts, displayStatus: displayStatus(order) }
  },

  /**
   * A guest's own order, proved by the number and the email together.
   *
   * The single message for every failure is deliberate: a wrong number and a
   * wrong email are indistinguishable to the caller, so this cannot be used to
   * learn which order numbers exist or which addresses have shopped here.
   */
  async lookupGuestOrder(orderNumber: string, email: string): Promise<OrderDetail> {
    const order = await repo.findGuestOrder(orderNumber.trim(), email.trim().toLowerCase())
    if (!order) throw new NotFoundError('No order matches that number and email address')
    return this.detail(order.id)
  },

  /** Scoped read: a customer's own order, or nothing. */
  async detailForCustomer(orderId: string, customerId: string): Promise<OrderDetail> {
    const order = await repo.findById(orderId)
    if (!order || order.customerId !== customerId) throw new NotFoundError('Order not found')
    return this.detail(orderId)
  },

  async list(filter: OrderListFilter) {
    return repo.list(filter)
  },

  /** The order's lines. Read by returns, which measures against them. */
  async items(orderId: string) {
    return repo.items(orderId)
  },

  async history(orderId: string) {
    return repo.history(orderId)
  },

  // ── Transitions ───────────────────────────────────────────────────────────

  /**
   * Moves one status field.
   *
   * The legality check and the compare-and-swap are both needed: the first
   * gives a clear error for an impossible move, the second stops two
   * simultaneous legal moves both applying.
   */
  async transition(
    orderId: string,
    field: 'status' | 'payment_status' | 'fulfillment_status',
    to: string,
    context: {
      actorUserId: string | null
      actorType: 'customer' | 'staff' | 'system' | 'webhook'
      reason?: string | null
      note?: string | null
    },
  ): Promise<Order> {
    return withTransaction(async () => {
      const order = await repo.lock(orderId)
      if (!order) throw new NotFoundError('Order not found')

      const current =
        field === 'status'
          ? order.status
          : field === 'payment_status'
            ? order.paymentStatus
            : order.fulfillmentStatus
      if (current === to) return order

      const legal =
        field === 'status'
          ? STATUS_TRANSITIONS[order.status]
          : field === 'payment_status'
            ? PAYMENT_TRANSITIONS[order.paymentStatus]
            : FULFILLMENT_TRANSITIONS[order.fulfillmentStatus]

      if (!(legal as string[]).includes(to)) {
        throw new DomainRuleError(
          ERROR_CODES.INVALID_ORDER_TRANSITION,
          `An order cannot go from ${current} to ${to}`,
        )
      }

      const timestamps: Record<string, 'now' | null> = {}
      if (field === 'status' && to === 'confirmed') timestamps.confirmed_at = 'now'
      if (field === 'status' && to === 'completed') timestamps.completed_at = 'now'
      if (field === 'status' && to === 'cancelled') timestamps.cancelled_at = 'now'

      const moved = await repo.transition({ orderId, field, from: current, to, timestamps })
      if (!moved) {
        throw new ConflictError('The order changed while you were working on it', {
          code: ERROR_CODES.CONCURRENT_MODIFICATION,
        })
      }

      await repo.recordStatusChange({
        orderId,
        field,
        fromValue: current,
        toValue: to,
        actorUserId: context.actorUserId,
        actorType: context.actorType,
        reason: context.reason ?? null,
        note: context.note ?? null,
      })

      await publish(
        'order.status_changed',
        { orderId, field, from: current, to, actorId: context.actorUserId },
        { aggregateId: orderId, actorUserId: context.actorUserId ?? undefined },
      )

      const updated = await repo.findById(orderId)
      if (!updated) throw new NotFoundError('Order not found')
      return updated
    })
  },

  /**
   * Confirms an order: payment is settled, the goods are committed.
   *
   * Committing the reservations is what actually removes the stock — until
   * this point it was only held. Doing it on confirmation rather than on
   * placement is what makes an unpaid order releasable.
   */
  async confirm(orderId: string, actor: Actor | null, actorType: 'staff' | 'system' | 'webhook' = 'system'): Promise<OrderDetail> {
    const order = await repo.findById(orderId)
    if (!order) throw new NotFoundError('Order not found')

    // A cancelled order is not "already confirmed" — it is one that must never
    // become confirmed. Treating every non-pending state as a harmless repeat
    // would quietly revive it, so the terminal states are refused explicitly
    // and only the states at or past confirmation short-circuit.
    if (order.status === 'cancelled') {
      throw new DomainRuleError(
        ERROR_CODES.INVALID_ORDER_TRANSITION,
        'A cancelled order cannot be confirmed',
      )
    }

    // Idempotent from here: confirmation is reached from three directions — a
    // payment landing, a staff member accepting a COD order, and the generic
    // transition endpoint — and any of them may arrive twice. Re-recording the
    // purchase would inflate the customer's lifetime spend.
    if (order.status !== 'pending') {
      log.debug({ orderId, status: order.status }, 'order already confirmed; nothing to do')
      return this.detail(orderId)
    }

    await this.transition(orderId, 'status', 'confirmed', {
      actorUserId: actor?.userId ?? null,
      actorType,
    })

    // Committing the reservations is what actually takes the stock off the
    // shelf. Until now it was only held, which is what made the order
    // cancellable without an adjustment.
    const reservations = await reservationsService.listFor('order', orderId)
    for (const reservation of reservations) {
      if (reservation.status === 'active') {
        await reservationsService.commit(reservation.id, actor)
      }
    }

    if (order.customerId) {
      await customersService.recordPurchase(order.customerId, order.totalCents, order.placedAt)
    }

    await publish(
      'order.confirmed',
      { orderId, orderNumber: order.orderNumber, email: order.email },
      { aggregateId: orderId, actorUserId: actor?.userId ?? undefined },
    )
    return this.detail(orderId)
  },

  /**
   * Cancels an order and returns the stock.
   *
   * Reservations that are still active are released; stock already committed is
   * put back with an explicit `return` movement, so the ledger says why it came
   * back rather than showing an unexplained increase.
   */
  async cancel(
    orderId: string,
    input: { reason?: string | null; restock?: boolean },
    actor: Actor | null,
    actorType: 'customer' | 'staff' | 'system' = 'staff',
  ): Promise<OrderDetail> {
    const order = await repo.findById(orderId)
    if (!order) throw new NotFoundError('Order not found')
    if (order.fulfillmentStatus !== 'unfulfilled') {
      throw new DomainRuleError(
        ERROR_CODES.INVALID_ORDER_TRANSITION,
        'A shipped order cannot be cancelled — refund and return it instead',
      )
    }

    const restock = input.restock ?? true
    await repo.setFields(orderId, { cancelReason: input.reason ?? null })

    await this.transition(orderId, 'status', 'cancelled', {
      actorUserId: actor?.userId ?? null,
      actorType,
      reason: input.reason ?? null,
    })

    if (restock) await this.restock(orderId, order.status === 'pending', actor)

    if (order.paymentStatus === 'pending') {
      await this.transition(orderId, 'payment_status', 'cancelled', {
        actorUserId: actor?.userId ?? null,
        actorType,
      })
    }

    if (actor) {
      await auditService.record({
        actor,
        action: 'order.cancelled',
        resourceType: 'order',
        resourceId: orderId,
        before: { status: order.status },
        after: { status: 'cancelled', reason: input.reason ?? null, restocked: restock },
      })
    }

    await publish(
      'order.cancelled',
      {
        orderId,
        orderNumber: order.orderNumber,
        email: order.email,
        reason: input.reason ?? null,
        restocked: restock,
      },
      { aggregateId: orderId, actorUserId: actor?.userId ?? undefined },
    )

    log.info({ orderId, reason: input.reason, restock }, 'order cancelled')
    return this.detail(orderId)
  },

  /**
   * Puts an order's stock back.
   *
   * `stillReserved` distinguishes the two cases: an unconfirmed order's stock
   * is merely held and is released, while a confirmed order's stock has left
   * and must be received back as a `return`.
   */
  /**
   * Returns specific units to the shelf, and records that they came back.
   *
   * The distinction from `restock` matters. That one puts back everything an
   * order still holds, which is right for a cancellation — the whole order is
   * off. A refund is different: it is an amount of money, and the units coming
   * back are whatever the customer actually returned. Refunding a pound of a
   * three-unit line does not mean three units are on the shelf again.
   *
   * `incrementRefunded` is the guard and the record at once. Its conditional
   * `WHERE refunded_quantity + $2 <= quantity` refuses to take back more units
   * than were bought however many partial refunds are issued, and the column it
   * maintains is what stops a later cancellation restocking the same units a
   * second time.
   */
  async recordRefundedUnits(
    orderId: string,
    items: { orderItemId: string; quantity: number }[],
    actor: Actor | null,
    options: { restock: boolean },
  ): Promise<void> {
    const lines = await repo.items(orderId)

    for (const requested of items) {
      const line = lines.find((item) => item.id === requested.orderItemId)
      if (!line) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          'That line does not belong to this order',
        )
      }

      const recorded = await repo.incrementRefunded(requested.orderItemId, requested.quantity)
      if (!recorded) {
        throw new DomainRuleError(
          ERROR_CODES.DOMAIN_RULE_VIOLATION,
          `That would refund more units of ${line.productTitle} than were ordered`,
        )
      }

      // The counter above is recorded either way; only the shelf movement is
      // optional. A refund that does not restock is still a refund of those
      // units, and `refunded_quantity` is what stops them being refunded twice.
      if (!options.restock) continue
      if (!line.variantId) continue
      await inventoryService.adjust(
        {
          variantId: line.variantId,
          delta: requested.quantity,
          reason: 'return',
          referenceType: 'order',
          referenceId: orderId,
          note: 'Returned to stock on refund',
        },
        actor,
      )
    }
  },

  /**
   * Puts an order's *remaining* stock back. Used by cancellation.
   *
   * Skips units already returned by a refund — `refundedQuantity` is what makes
   * that possible, and is why a refund records the units it took back rather
   * than only the money.
   */
  async restock(orderId: string, stillReserved: boolean, actor: Actor | null): Promise<void> {
    if (stillReserved) {
      const reservations = await reservationsService.listFor('order', orderId)
      for (const reservation of reservations) {
        if (reservation.status === 'active') {
          await reservationsService.release(reservation.id, actor)
        }
      }
      return
    }

    const items = await repo.items(orderId)
    for (const item of items) {
      if (!item.variantId) continue
      const returnable = item.quantity - item.refundedQuantity
      if (returnable <= 0) continue
      await inventoryService.adjust(
        {
          variantId: item.variantId,
          delta: returnable,
          reason: 'return',
          referenceType: 'order',
          referenceId: orderId,
          note: 'Returned to stock on cancellation',
        },
        actor,
      )
    }
  },

  async setAdminNote(orderId: string, note: string | null, actor: Actor): Promise<OrderDetail> {
    await repo.setFields(orderId, { adminNote: note })
    await auditService.record({
      actor,
      action: 'order.note_changed',
      resourceType: 'order',
      resourceId: orderId,
      after: { adminNote: note },
    })
    return this.detail(orderId)
  },

  // ── Notes, tags and the timeline ──────────────────────────────────────────

  /**
   * One staff observation, appended.
   *
   * Notes are appended and deleted, never edited: a record of what somebody
   * observed at a moment stops being that the moment it can be rewritten, and
   * the timeline it feeds is meant to be evidence.
   */
  async addNote(orderId: string, body: string, actor: Actor): Promise<OrderNote> {
    await this.getRaw(orderId)
    const note = await repo.insertNote({
      id: uuidv7(),
      orderId,
      authorUserId: actor.userId,
      // Snapshotted, so the note still says who wrote it after the account goes.
      // `timeline` prefers the live name when the account is still there.
      authorName: actor.email,
      body: body.trim(),
    })
    await auditService.record({
      actor,
      action: 'order.note_added',
      resourceType: 'order',
      resourceId: orderId,
      after: { noteId: note.id },
    })
    return note
  },

  async notes(orderId: string): Promise<OrderNote[]> {
    return repo.notes(orderId)
  },

  async deleteNote(orderId: string, noteId: string, actor: Actor): Promise<void> {
    const removed = await repo.deleteNote(orderId, noteId)
    if (removed === 0) throw new NotFoundError('Note not found')
    await auditService.record({
      actor,
      action: 'order.note_deleted',
      resourceType: 'order',
      resourceId: orderId,
      before: { noteId },
    })
  },

  /**
   * The pinned note and the tags, together.
   *
   * One call because they are one edit in the interface — the panel where a
   * staff member writes "leave with neighbour" and tags it `fragile` — and two
   * requests would leave half of it saved when the second failed.
   */
  async setAnnotations(
    orderId: string,
    patch: { note?: string | null; tags?: string[] },
    actor: Actor,
  ): Promise<OrderDetail> {
    const before = await this.getRaw(orderId)

    // Trimmed, de-duplicated case-insensitively, and order preserved: two tags
    // differing only in case are one tag, and the first spelling is the one the
    // operator typed.
    const tags =
      patch.tags === undefined
        ? undefined
        : patch.tags.reduce<string[]>((kept, raw) => {
            const tag = raw.trim()
            if (tag === '') return kept
            if (kept.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return kept
            kept.push(tag)
            return kept
          }, [])

    await repo.setFields(orderId, {
      ...(patch.note === undefined ? {} : { adminNote: patch.note }),
      ...(tags === undefined ? {} : { tags }),
    })

    await auditService.record({
      actor,
      action: 'order.annotated',
      resourceType: 'order',
      resourceId: orderId,
      before: { adminNote: before.adminNote, tags: before.tags },
      after: {
        adminNote: patch.note === undefined ? before.adminNote : patch.note,
        tags: tags ?? before.tags,
      },
    })
    return this.detail(orderId)
  },

  /**
   * Everything that has happened to an order, newest first.
   *
   * Assembled at read time from the tables that already hold each kind of
   * event, rather than written to an events table as things happen. A stored
   * feed is a second copy of the truth: it can disagree with the status
   * history, and it can miss whatever the code forgot to write to it. Composing
   * it here means the timeline cannot say anything the underlying records do
   * not, and a new kind of event shows up by being added to this list.
   */
  async timeline(orderId: string): Promise<TimelineEntry[]> {
    await this.getRaw(orderId)

    const [history, notes, payments, refunds, shipments] = await Promise.all([
      repo.history(orderId),
      repo.notes(orderId),
      paymentsService.listForOrder(orderId),
      paymentsService.listRefundsForOrder(orderId),
      shippingService.listForOrder(orderId),
    ])

    const entries: TimelineEntry[] = [
      ...history.map((entry) => ({
        kind: 'status' as const,
        id: `status:${entry.id}`,
        at: entry.createdAt,
        actorUserId: entry.actorUserId,
        actorName: null,
        field: entry.field,
        from: entry.fromValue,
        to: entry.toValue,
        reason: entry.reason,
        note: entry.note,
      })),
      ...notes.map((note) => ({
        kind: 'note' as const,
        id: `note:${note.id}`,
        at: note.createdAt,
        actorUserId: note.authorUserId,
        actorName: note.authorName,
        body: note.body,
      })),
      ...payments.map((payment) => ({
        kind: 'payment' as const,
        id: `payment:${payment.id}`,
        at: payment.capturedAt ?? payment.createdAt,
        actorUserId: null,
        actorName: null,
        amountCents: payment.amountCents,
        method: payment.method,
        provider: payment.provider,
        status: payment.status,
      })),
      ...refunds.map((refund) => ({
        kind: 'refund' as const,
        id: `refund:${refund.id}`,
        at: refund.createdAt,
        actorUserId: null,
        actorName: null,
        amountCents: refund.amountCents,
        reason: refund.reason,
        restock: refund.restock,
      })),
      ...shipments.map((shipment) => ({
        kind: 'shipment' as const,
        id: `shipment:${shipment.id}`,
        at: shipment.shippedAt ?? shipment.createdAt,
        actorUserId: null,
        actorName: null,
        status: shipment.status,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        itemCount: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
      })),
    ]

    // One lookup for every actor the feed mentions, rather than a join on five
    // source tables that would still miss a deleted account.
    const ids = [...new Set(entries.map((entry) => entry.actorUserId).filter((id): id is string => id !== null))]
    const names = await repo.actorNames(ids)

    return entries
      .map((entry) => ({
        ...entry,
        actorName: entry.actorName ?? (entry.actorUserId ? (names.get(entry.actorUserId) ?? null) : null),
      }))
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
  },

  async getRaw(orderId: string): Promise<Order> {
    const order = await repo.findById(orderId)
    if (!order) throw new NotFoundError('Order not found')
    return order
  },
}
