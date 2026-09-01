/**
 * The payment method registry (§5.7).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * v1 sells with cash on delivery. A card gateway is coming. The difference
 * between those two is not "one more `if`" scattered through checkout — they
 * disagree about *when the money arrives*, and that single fact changes four
 * separate behaviours:
 *
 *   settlement    does the order confirm when payment lands, or when staff
 *                 decide to ship it?
 *   the sweep     is an unpaid order abandoned, or simply not yet delivered?
 *   the surcharge is there a handling fee, and how much?
 *   eligibility   may this cart, in this country, for this customer, use it?
 *
 * Every one of those is answered here, per method, in one table. Adding a card
 * gateway later means adding an entry and implementing its authorisation —
 * not revisiting checkout, the expiry job, and the admin console to find the
 * places that assumed cash.
 *
 * ── The two settlement models ───────────────────────────────────────────────
 *
 *   `on_delivery`  the money arrives after the goods do. The order confirms
 *                  and commits stock on the shop's decision, not on payment,
 *                  and it must never be swept up as abandoned. COD.
 *
 *   `before_delivery`  the money arrives first. The order stays pending until
 *                  it does, confirms when it does, and is abandoned if it
 *                  never does. Card, bank transfer, and staff marking paid.
 *
 * A method's settlement model is the thing to reason about. Nothing outside
 * this file should branch on the string `'cod'`.
 */
import type { Money } from '../catalogue/index.js'
import type { StoreSettings } from '../settings/index.js'

export type PaymentMethodKey = 'cod' | 'manual' | 'bank_transfer' | 'card'

export type SettlementModel = 'on_delivery' | 'before_delivery'

export interface MethodContext {
  settings: StoreSettings
  subtotalCents: number
  countryCode: string
  customerId: string | null
  /** False for a wholly digital basket — nothing to hand cash over for. */
  requiresShipping: boolean
  /** Unpaid COD orders this customer already holds. Zero for a guest. */
  openCodOrders: number
}

/** Why a method is not on offer. Shown to staff; summarised for customers. */
export interface Ineligible {
  eligible: false
  reason: string
}
export interface Eligible {
  eligible: true
}
export type Eligibility = Eligible | Ineligible

export interface PaymentMethodDefinition {
  key: PaymentMethodKey
  label: string
  description: string
  settlement: SettlementModel
  /**
   * Whether a customer may pick this at checkout.
   *
   * `manual` is false: it is what staff use to record a payment that arrived
   * some other way — a bank transfer they can see in the account, cash over the
   * counter. Offering it on the storefront would be a "mark my own order paid"
   * button.
   */
  selectableAtCheckout: boolean
  /** Whether this method is switched on at all, given the store's settings. */
  enabled: (settings: StoreSettings) => boolean
  /** The surcharge in minor units. Integer, like every other amount. */
  feeCents: (context: MethodContext) => number
  /** Whether this specific basket, address and customer may use it. */
  eligibility: (context: MethodContext) => Eligibility
}

const eligible: Eligibility = { eligible: true }
const no = (reason: string): Eligibility => ({ eligible: false, reason })

/**
 * Cash on delivery.
 *
 * The eligibility rules are not bureaucracy — each one is a way COD loses
 * money, written down. A refused delivery means goods that travelled, were
 * never paid for, and have to come back; the ceiling, the country whitelist,
 * the account requirement and the open-order cap are the four levers a store
 * has against that, and all four are settings so the owner can tighten them
 * the week it starts happening rather than the release after.
 */
const cashOnDelivery: PaymentMethodDefinition = {
  key: 'cod',
  label: 'Cash on delivery',
  description: 'Pay the courier in cash when your order arrives.',
  settlement: 'on_delivery',
  selectableAtCheckout: true,
  enabled: (settings) => settings.codEnabled,

  feeCents: (context) => context.settings.codFeeCents,

  eligibility: (context) => {
    const s = context.settings
    if (!s.codEnabled) return no('Cash on delivery is not available')

    // Nothing is being delivered, so there is no doorstep to pay at.
    if (!context.requiresShipping) {
      return no('Cash on delivery needs an order that is physically delivered')
    }

    if (context.subtotalCents < s.codMinSubtotalCents) {
      return no('This order is below the minimum for cash on delivery')
    }
    if (s.codMaxSubtotalCents !== null && context.subtotalCents > s.codMaxSubtotalCents) {
      return no('This order is above the maximum for cash on delivery')
    }

    // An empty whitelist means "everywhere the store ships".
    if (
      s.codCountryCodes.length > 0 &&
      !s.codCountryCodes.includes(context.countryCode.toUpperCase())
    ) {
      return no('Cash on delivery is not available for this delivery address')
    }

    if (s.codRequiresAccount && !context.customerId) {
      return no('Sign in to pay with cash on delivery')
    }

    // The cap is per customer, so a guest is never over it — which is exactly
    // why `codRequiresAccount` exists as a separate lever.
    if (
      s.codMaxOpenOrders !== null &&
      context.customerId &&
      context.openCodOrders >= s.codMaxOpenOrders
    ) {
      return no('You already have the maximum number of unpaid orders')
    }

    return eligible
  },
}

/**
 * Staff recording money that arrived outside the system.
 *
 * Never selectable at checkout; it exists so that "the customer paid us
 * somehow" has an honest name in the payments table rather than being
 * mislabelled as a card capture.
 */
const manual: PaymentMethodDefinition = {
  key: 'manual',
  label: 'Recorded by staff',
  description: 'A payment received outside the store and entered by hand.',
  settlement: 'before_delivery',
  selectableAtCheckout: false,
  enabled: () => true,
  feeCents: () => 0,
  eligibility: () => eligible,
}

/**
 * Bank transfer and card are declared but switched off.
 *
 * They are here rather than absent so that the shape of a second and third
 * method is visible now, while COD is the only one in use — and so the day one
 * of them is turned on, the work is implementing its settlement, not
 * discovering every place that assumed there was only ever one method.
 */
const bankTransfer: PaymentMethodDefinition = {
  key: 'bank_transfer',
  label: 'Bank transfer',
  description: 'Transfer the total to the store’s account before dispatch.',
  settlement: 'before_delivery',
  selectableAtCheckout: false,
  enabled: () => false,
  feeCents: () => 0,
  eligibility: () => no('Bank transfer is not available yet'),
}

const card: PaymentMethodDefinition = {
  key: 'card',
  label: 'Card',
  description: 'Pay by card.',
  settlement: 'before_delivery',
  selectableAtCheckout: false,
  // Turning this on needs a gateway, a webhook handler and an authorise/capture
  // flow — not a flag. It stays false until those exist.
  enabled: () => false,
  feeCents: () => 0,
  eligibility: () => no('Card payment is not available yet'),
}

export const PAYMENT_METHODS: Record<PaymentMethodKey, PaymentMethodDefinition> = {
  cod: cashOnDelivery,
  manual,
  bank_transfer: bankTransfer,
  card,
}

export function getPaymentMethod(key: string): PaymentMethodDefinition | undefined {
  return PAYMENT_METHODS[key as PaymentMethodKey]
}

/** True when the money is only expected after the goods arrive. */
export function settlesOnDelivery(key: string): boolean {
  return getPaymentMethod(key)?.settlement === 'on_delivery'
}

/**
 * The methods a customer may choose for this basket, each with its fee.
 *
 * Checkout calls this and then re-checks the one that was chosen, rather than
 * trusting the choice: the offer a browser is holding may be minutes old and
 * the settings may have changed underneath it.
 *
 * `customerFacing: false` is for staff building a draft order, and it drops
 * exactly one filter — `selectableAtCheckout`, which asks whether a *shopper*
 * may pick the method. `enabled` and `eligibility` still apply, so staff are
 * offered `manual` but are no more able to put an over-ceiling order on cash
 * on delivery than a customer is.
 */
export function availableMethods(
  context: MethodContext,
  options: { customerFacing?: boolean } = {},
): {
  key: PaymentMethodKey
  label: string
  description: string
  feeCents: number
}[] {
  const customerFacing = options.customerFacing ?? true
  return Object.values(PAYMENT_METHODS)
    .filter((method) => (customerFacing ? method.selectableAtCheckout : true))
    .filter((method) => method.enabled(context.settings))
    .filter((method) => method.eligibility(context).eligible)
    .map((method) => ({
      key: method.key,
      label: method.label,
      description: method.description,
      feeCents: method.feeCents(context),
    }))
}

/** For a serialiser that wants the fee as `{ amount, currency }`. */
export function feeAsMoney(feeCents: number, currency: string): Money {
  return { amount: feeCents, currency }
}
