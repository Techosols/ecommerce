/**
 * The payment method registry (§5.7).
 *
 * These rules are pure functions over a context, which is exactly why they are
 * written that way: every COD policy decision — the ceiling, the country list,
 * the account requirement, the open-order cap — is testable here without a
 * database, a request or a cart.
 *
 * The cases below are the ways COD loses money, one test each.
 */
import { describe, expect, it } from 'vitest'
import {
  PAYMENT_METHODS,
  availableMethods,
  getPaymentMethod,
  settlesOnDelivery,
  type MethodContext,
} from '../../src/features/payments/methods.js'
import type { StoreSettings } from '../../src/features/settings/index.js'

function settings(overrides: Partial<StoreSettings> = {}): StoreSettings {
  return {
    storeName: 'Test Store',
    contactEmail: 'store@example.test',
    supportUrl: null,
    supportPhone: null,
    currency: 'USD',
    timezone: 'UTC',
    weightUnit: 'g',
    taxRateBps: 0,
    pricesIncludeTax: false,
    defaultLowStockThreshold: 5,
    orderNumberPrefix: '#',
    reservationTtlMinutes: 60,
    guestCheckoutEnabled: true,
    codEnabled: true,
    codMinSubtotalCents: 0,
    codMaxSubtotalCents: null,
    codFeeCents: 0,
    codCountryCodes: [],
    codRequiresAccount: false,
    bankTransferEnabled: false,
    bankAccountName: null,
    bankName: null,
    bankAccountNumber: null,
    bankIban: null,
    bankSwift: null,
    bankInstructions: null,
    adminNotificationEmails: [],
    codMaxOpenOrders: null,
    orderReservationHours: 192,
    logoMediaId: null,
    metadata: {},
    updatedAt: new Date(),
    updatedBy: null,
    ...overrides,
  }
}

function context(overrides: Partial<MethodContext> = {}): MethodContext {
  return {
    settings: settings(),
    subtotalCents: 5000,
    countryCode: 'GB',
    customerId: null,
    signedIn: false,
    requiresShipping: true,
    openCodOrders: 0,
    ...overrides,
  }
}

const cod = PAYMENT_METHODS.cod

describe('payment method registry', () => {
  it('knows its methods and rejects an unknown key', () => {
    expect(getPaymentMethod('cod')?.key).toBe('cod')
    expect(getPaymentMethod('bitcoin')).toBeUndefined()
  })

  it('distinguishes the two settlement models', () => {
    // The single fact everything else branches on.
    expect(settlesOnDelivery('cod')).toBe(true)
    expect(settlesOnDelivery('card')).toBe(false)
    expect(settlesOnDelivery('manual')).toBe(false)
  })
})

describe('cash on delivery eligibility', () => {
  it('is offered for an ordinary shippable basket', () => {
    expect(cod.eligibility(context())).toEqual({ eligible: true })
  })

  it('is refused when the store has switched it off', () => {
    const verdict = cod.eligibility(context({ settings: settings({ codEnabled: false }) }))
    expect(verdict.eligible).toBe(false)
  })

  it('is refused for a basket with nothing to deliver', () => {
    // No doorstep, so no cash at the door. A digital-only basket must not be
    // able to pick a method that is settled by a courier.
    const verdict = cod.eligibility(context({ requiresShipping: false }))
    expect(verdict).toMatchObject({ eligible: false })
    expect((verdict as { reason: string }).reason).toMatch(/delivered/i)
  })

  it('enforces the floor', () => {
    const ctx = context({
      subtotalCents: 999,
      settings: settings({ codMinSubtotalCents: 1000 }),
    })
    expect((cod.eligibility(ctx) as { reason: string }).reason).toMatch(/below the minimum/i)
    // And one penny over the line is fine.
    expect(cod.eligibility({ ...ctx, subtotalCents: 1000 }).eligible).toBe(true)
  })

  it('enforces the ceiling — the main defence against a refused delivery', () => {
    const ctx = context({
      subtotalCents: 20_001,
      settings: settings({ codMaxSubtotalCents: 20_000 }),
    })
    expect((cod.eligibility(ctx) as { reason: string }).reason).toMatch(/above the maximum/i)
    expect(cod.eligibility({ ...ctx, subtotalCents: 20_000 }).eligible).toBe(true)
  })

  it('treats an empty country list as "everywhere we ship"', () => {
    expect(cod.eligibility(context({ countryCode: 'JP' })).eligible).toBe(true)
  })

  it('honours a non-empty country list as a whitelist', () => {
    const ctx = context({ settings: settings({ codCountryCodes: ['GB', 'IE'] }) })
    expect(cod.eligibility({ ...ctx, countryCode: 'GB' }).eligible).toBe(true)
    expect(cod.eligibility({ ...ctx, countryCode: 'FR' }).eligible).toBe(false)
    // Case is normalised, so a lowercase code from a client is not a refusal.
    expect(cod.eligibility({ ...ctx, countryCode: 'gb' }).eligible).toBe(true)
  })

  it('can be restricted to account holders', () => {
    const ctx = context({ settings: settings({ codRequiresAccount: true }) })
    expect(cod.eligibility(ctx).eligible).toBe(false)
    expect(cod.eligibility({ ...ctx, signedIn: true }).eligible).toBe(true)
  })

  it('still refuses a guest who has a customer record but did not sign in', () => {
    // The case this setting exists for. Checkout gives every guest a customer
    // record now, so a rule keyed on `customerId` would wave them all through
    // and the lever would quietly do nothing.
    const ctx = context({
      settings: settings({ codRequiresAccount: true }),
      customerId: 'a-customer-made-at-checkout',
      signedIn: false,
    })
    expect(cod.eligibility(ctx).eligible).toBe(false)
    expect(cod.eligibility(ctx)).toMatchObject({ reason: expect.stringMatching(/sign in/i) })
  })

  it('caps how many unpaid COD orders one customer may hold', () => {
    const ctx = context({
      customerId: 'a-customer',
      openCodOrders: 3,
      settings: settings({ codMaxOpenOrders: 3 }),
    })
    expect((cod.eligibility(ctx) as { reason: string }).reason).toMatch(/maximum number of unpaid/i)
    expect(cod.eligibility({ ...ctx, openCodOrders: 2 }).eligible).toBe(true)
  })

  it('cannot apply the open-order cap to a guest, which is why the account flag exists', () => {
    // A guest has no identity to count against, so the cap is silently
    // inapplicable. A store that cares must also require an account — the two
    // settings are deliberately separate levers.
    const ctx = context({
      customerId: null,
      openCodOrders: 99,
      settings: settings({ codMaxOpenOrders: 1 }),
    })
    expect(cod.eligibility(ctx).eligible).toBe(true)
  })
})

describe('surcharges', () => {
  it('charges the configured COD handling fee', () => {
    expect(cod.feeCents(context({ settings: settings({ codFeeCents: 250 }) }))).toBe(250)
  })

  it('charges nothing when no fee is configured', () => {
    expect(cod.feeCents(context())).toBe(0)
  })
})

describe('what a customer may choose', () => {
  it('offers COD and nothing else in v1', () => {
    expect(availableMethods(context()).map((m) => m.key)).toEqual(['cod'])
  })

  it('never offers the staff-only manual method', () => {
    // `manual` is how staff record money that arrived some other way. Offering
    // it on the storefront would be a "mark my own order paid" button.
    expect(PAYMENT_METHODS.manual.selectableAtCheckout).toBe(false)
    expect(availableMethods(context()).map((m) => m.key)).not.toContain('manual')
  })

  it('offers nothing when COD is off and no gateway is configured', () => {
    // The honest empty state: a store with no way to take money shows no
    // options, rather than showing one that will fail at checkout.
    expect(availableMethods(context({ settings: settings({ codEnabled: false }) }))).toEqual([])
  })

  it('omits a method this particular basket cannot use', () => {
    expect(
      availableMethods(context({ subtotalCents: 99_999, settings: settings({ codMaxSubtotalCents: 5000 }) })),
    ).toEqual([])
  })

  it('carries the fee with each option, so a client need not compute it', () => {
    const [option] = availableMethods(context({ settings: settings({ codFeeCents: 199 }) }))
    expect(option).toMatchObject({ key: 'cod', feeCents: 199 })
    expect(option?.label).toBeTruthy()
  })

  it('declares card and bank transfer but does not offer them yet', () => {
    // They exist so the shape of a second method is visible now; turning one on
    // needs a gateway, not a flag.
    expect(PAYMENT_METHODS.card.enabled(settings())).toBe(false)
    expect(PAYMENT_METHODS.bank_transfer.enabled(settings())).toBe(false)
  })
})
