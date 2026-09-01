/**
 * Checkout composition (§5.6).
 *
 * `ordersService.checkout()` deliberately knows nothing about shipping or
 * discounts: it takes callbacks. This file is where those callbacks are bound
 * to the real services, and it exists so that the dependency runs one way —
 * checkout → shipping, checkout → discounts — with neither of those features
 * ever learning that orders exist.
 *
 * That is not ceremony. It is what lets a shipping rate be tested without a
 * cart, and what stops "rate a delivery" and "place an order" becoming the same
 * function.
 */
import type { Actor } from '../../shared/auth/actor.js'
import { DomainRuleError, ERROR_CODES } from '../../shared/errors/index.js'
import { cartsService, type ResolvedCart } from '../carts/index.js'
import { customersService } from '../customers/index.js'
import { discountsService } from '../discounts/index.js'
import { availableMethods, getPaymentMethod, type MethodContext } from '../payments/index.js'
import { settingsService, taxAddedTo } from '../settings/index.js'
import { shippingService } from '../shipping/index.js'
import { ordersRepository } from './orders.repository.js'
import { ordersService } from './orders.service.js'
import type { CheckoutInput, OrderDetail } from './orders.types.js'

/**
 * Assembles everything the payment-method rules need to judge a basket.
 *
 * The open-COD count is fetched here rather than inside the rule, so the rules
 * stay pure functions over a context — testable without a database, and honest
 * about exactly what they depend on.
 */
async function methodContext(args: {
  subtotalCents: number
  countryCode: string
  customerId: string | null
  signedIn: boolean
  requiresShipping: boolean
}): Promise<MethodContext> {
  return {
    settings: await settingsService.get(),
    subtotalCents: args.subtotalCents,
    countryCode: args.countryCode,
    customerId: args.customerId,
    signedIn: args.signedIn,
    requiresShipping: args.requiresShipping,
    openCodOrders: args.customerId ? await ordersRepository.countOpenCod(args.customerId) : 0,
  }
}

export const checkoutService = {
  /**
   * Places an order from a cart.
   *
   * Every figure is computed inside: the caller supplies an address, an email,
   * a method id and possibly a code. Shipping is re-rated against the
   * destination rather than trusted from the page, and the discount is quoted
   * *and* consumed under the same transaction as the order.
   */
  async place(
    input: CheckoutInput,
    context: { customerId: string | null; source?: 'storefront' | 'admin'; actor?: Actor | null },
  ): Promise<OrderDetail> {
    /**
     * A guest becomes a customer here, before anything is priced or reserved.
     *
     * This is the only line that makes it happen, and it is placed here rather
     * than inside `ordersService.checkout` on purpose: resolving the id *first*
     * means everything downstream — `assertCanOrder`, per-customer discount
     * limits, the cash-on-delivery open-order cap, the order's `customer_id`,
     * and the `recordPurchase` that follows payment — sees a real customer
     * with no further change. Guest checkout was previously a way around every
     * one of those per-customer rules; it no longer is.
     *
     * `placeDraft` deliberately does not do this. A staff member who left the
     * customer field empty on a draft meant to.
     */
    // Captured before the line below, which is the whole point: after it,
    // `customerId` is set for everybody and can no longer answer this.
    const signedIn = context.customerId !== null

    const customerId =
      context.customerId ??
      (await customersService.ensureForCheckout({
        email: input.email,
        firstName: input.shippingAddress.firstName,
        lastName: input.shippingAddress.lastName,
        phone: input.phone ?? input.shippingAddress.phone ?? null,
      }))

    return ordersService.checkout(input, {
      ...context,
      customerId,
      quoteShipping: (args) => shippingService.rateForCheckout(args),
      applyDiscount: (args) => discountsService.quote({ ...args, signedIn }),
      redeemDiscount: (args) => discountsService.redeem(args),
      resolvePaymentMethod: (args) => this.resolveMethod({ ...args, signedIn }),
    })
  },

  /**
   * Places an order from a draft's basket rather than from a cart.
   *
   * The same function, the same hooks, the same transaction: the only
   * difference is where the lines came from. Shipping is still re-rated
   * against the address and the code is still quoted and consumed here, so a
   * staff-built order is priced by exactly the rules a customer's would be —
   * a draft cannot be used to sell something at a price checkout would refuse.
   */
  async placeDraft(
    input: Omit<CheckoutInput, 'cartId'> & { basket: ResolvedCart },
    context: { customerId: string | null; actor: Actor },
  ): Promise<OrderDetail> {
    const { basket, ...rest } = input
    return ordersService.checkout(
      // `cartId` names the draft, which is what the audit trail and the
      // idempotency record should point at. Nothing loads a cart by it:
      // `basket` is supplied, so checkout uses that.
      { ...rest, cartId: basket.cart.id },
      {
        basket,
        customerId: context.customerId,
        source: 'admin',
        actor: context.actor,
        quoteShipping: (args) => shippingService.rateForCheckout(args),
        applyDiscount: (args) => discountsService.quote(args),
        redeemDiscount: (args) => discountsService.redeem(args),
        // Staff, not a customer — so `manual` is allowed here and nowhere else.
        // `signedIn` follows whether staff named a customer: they either
        // identified this buyer or deliberately did not.
        resolvePaymentMethod: (args) =>
          this.resolveMethod(
            { ...args, signedIn: context.customerId !== null },
            { customerFacing: false },
          ),
      },
    )
  },

  /**
   * Validates a chosen payment method and returns its surcharge.
   *
   * Three separate refusals, because they are three different problems for the
   * person reading the message: the method does not exist, the method is not
   * on offer at all, or the method is on offer but not for *this* basket. The
   * last one carries the rule's own reason — "above the maximum for cash on
   * delivery" is actionable, "payment method unavailable" is not.
   *
   * `customerFacing` is the one thing a staff placement relaxes, and it relaxes
   * exactly one gate: `selectableAtCheckout`, which asks whether a *customer*
   * may pick this method. Whether the method is switched on at all, and whether
   * this particular basket qualifies for it, are the store's money rules and
   * apply to staff identically — an order over the COD ceiling is refused no
   * matter who typed it in.
   */
  async resolveMethod(
    args: {
      method: string
      subtotalCents: number
      countryCode: string
      customerId: string | null
      /** Whether the shopper authenticated, as opposed to merely being known. */
      signedIn: boolean
      requiresShipping: boolean
    },
    options: { customerFacing?: boolean } = {},
  ): Promise<{ key: string; feeCents: number }> {
    const customerFacing = options.customerFacing ?? true
    const definition = getPaymentMethod(args.method)
    if (!definition) {
      throw new DomainRuleError(ERROR_CODES.PAYMENT_METHOD_INVALID, 'Unknown payment method')
    }

    const context = await methodContext(args)

    // `selectableAtCheckout` is what keeps `manual` — the staff "mark it paid"
    // method — off the storefront. Without this check a customer could settle
    // their own order by naming it.
    if ((customerFacing && !definition.selectableAtCheckout) || !definition.enabled(context.settings)) {
      throw new DomainRuleError(
        ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE,
        `${definition.label} is not available`,
      )
    }

    const verdict = definition.eligibility(context)
    if (!verdict.eligible) {
      throw new DomainRuleError(ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE, verdict.reason)
    }

    return { key: definition.key, feeCents: definition.feeCents(context) }
  },

  /**
   * What checkout *would* cost, without placing anything.
   *
   * The storefront needs this to show delivery options and the effect of a code
   * before anyone commits, and it must produce the same numbers the real
   * checkout will — so it runs the same rating and quoting code rather than a
   * parallel copy that can drift.
   *
   * `basket` lets a draft order be quoted by this same function: a draft's
   * lines are not a cart, but they resolve to the same shape, and the whole
   * value of quoting them here is that the figure a staff member reads down
   * the phone is the figure checkout will charge.
   */
  async preview(input: {
    cartId: string
    basket?: ResolvedCart
    countryCode: string
    shippingMethodId?: string | null
    discountCode?: string | null
    paymentMethod?: string | null
    customerId: string | null
    /** Staff quoting a draft may name `manual`; a shopper may not. */
    customerFacing?: boolean
  }) {
    const cart = input.basket ?? (await cartsService.resolve(input.cartId))
    const subtotal = cart.totals.subtotal.amount
    const weightGrams = cart.lines.reduce(
      (sum, line) => sum + line.weightGrams * line.quantity,
      0,
    )
    const needsShipping = cart.lines.some((line) => line.requiresShipping)

    let discount: Awaited<ReturnType<typeof discountsService.quote>> | null = null
    if (input.discountCode) {
      // A bad code is a 4xx here, exactly as it would be at checkout, so the
      // customer finds out before they have filled in a card form.
      discount = await discountsService.quote({
        code: input.discountCode,
        subtotalCents: subtotal,
        customerId: input.customerId,
        // A preview runs before any guest record exists, so these still agree.
        signedIn: input.customerId !== null,
        lines: cart.lines.map((line) => ({
          productId: line.productId,
          lineTotalCents: line.lineTotal.amount,
        })),
      })
    }

    const discountTotal = Math.min(discount?.amountCents ?? 0, subtotal)
    const options = needsShipping
      ? await shippingService.quote({
          countryCode: input.countryCode,
          subtotalCents: subtotal - discountTotal,
          weightGrams,
        })
      : []

    const chosen =
      options.find((option) => option.methodId === input.shippingMethodId) ?? options[0] ?? null
    const shippingTotal = discount?.freeShipping ? 0 : (chosen?.amountCents ?? 0)

    // Which ways of paying this basket may use, with their surcharges. The
    // storefront needs this to render the choice, and it comes from the same
    // rules checkout will re-run — so an option shown here is one that will be
    // accepted, unless the settings change in between.
    const context = await methodContext({
      subtotalCents: subtotal,
      countryCode: input.countryCode,
      customerId: input.customerId,
      // A preview runs before any guest record exists, so the two questions
      // still have the same answer here.
      signedIn: input.customerId !== null,
      requiresShipping: needsShipping,
    })
    const methods = availableMethods(context, {
      customerFacing: input.customerFacing ?? true,
    })

    const selectedMethod =
      methods.find((method) => method.key === input.paymentMethod) ?? methods[0] ?? null

    // The same two lines checkout runs, from the same helper — so a preview
    // that says £47.94 is a checkout that charges £47.94.
    const taxTotal = taxAddedTo(subtotal - discountTotal, context.settings)
    const paymentFee = selectedMethod?.feeCents ?? 0

    return {
      currency: cart.cart.currency,
      subtotalCents: subtotal,
      discountTotalCents: discountTotal,
      shippingTotalCents: shippingTotal,
      taxTotalCents: taxTotal,
      paymentFeeCents: paymentFee,
      totalCents: subtotal - discountTotal + taxTotal + shippingTotal + paymentFee,
      shippingOptions: options,
      selectedShippingMethodId: chosen?.methodId ?? null,
      paymentMethods: methods,
      selectedPaymentMethod: selectedMethod?.key ?? null,
      discount: discount
        ? { code: discount.code, type: discount.type, amountCents: discountTotal }
        : null,
      purchasable: cart.purchasable,
    }
  },
}
