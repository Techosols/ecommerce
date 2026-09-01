import type { Money, OffsetQuery } from '@/types/api'

/**
 * Orders staff build by hand.
 *
 * Mirrored from the `/admin/drafts` routes. Three facts shape how every one of
 * these reads, and they are worth stating because the screen is only honest if
 * it respects them:
 *
 *   • **A draft holds no stock.** Nothing is reserved while it is being built.
 *     The shelf is untouched until it is placed, which is also when a line can
 *     turn out to have sold out from under the quote.
 *
 *   • **A draft does not price itself.** Every figure here was computed by the
 *     server, by the same code that prices a storefront checkout. The admin
 *     multiplies nothing and adds nothing up.
 *
 *   • **Placing it makes a separate order.** The draft stays behind, pointing
 *     at what it became, as the record of what was quoted and by whom.
 */

export interface DraftSummary {
  id: string
  /** `DRAFT-XXXXXX` until it is placed and earns a real order number. */
  reference: string
  customerId: string | null
  email: string | null
  customerNote: string | null
  /** The lines as of the last edit. `total` on the detail is authoritative. */
  subtotal: Money
  draftedBy: string | null
  placedOrderId: string | null
  placedFromDraftAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DraftLine {
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string | null
  sku: string | null
  imageUrl: string | null
  quantity: number
  unitPrice: Money
  lineTotal: Money
  purchasable: boolean
  /** Why this line cannot be bought — archived, unpublished, out of stock. */
  problem: string | null
}

export interface DraftAddress {
  type: 'shipping' | 'billing'
  firstName: string
  lastName: string
  company: string | null
  line1: string
  line2: string | null
  city: string
  region: string | null
  postalCode: string | null
  countryCode: string
  phone: string | null
}

export interface DraftShippingOption {
  methodId: string
  name: string
  description: string | null
  amount: Money
  estimatedDaysMin: number | null
  estimatedDaysMax: number | null
}

export interface DraftPaymentOption {
  key: string
  label: string
  description: string
  fee: Money
}

export interface DraftDetail extends DraftSummary {
  phone: string | null
  paymentMethod: string
  shippingMethodId: string | null
  discountCode: string | null
  addresses: DraftAddress[]
  lines: DraftLine[]
  discountTotal: Money
  shippingTotal: Money
  taxTotal: Money
  paymentFee: Money
  total: Money
  shippingOptions: DraftShippingOption[]
  paymentMethods: DraftPaymentOption[]
  purchasable: boolean
  /**
   * What stops it being placed, in the order a person would fix them.
   *
   * Listed rather than thrown, because a draft is *expected* to be incomplete
   * while somebody is building it. An empty list is the only thing that means
   * "ready", and it is the server's answer, not a check repeated here.
   */
  blockers: string[]
}

/** A product a staff member can put on a draft. */
export interface VariantMatch {
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string | null
  sku: string | null
  price: Money
}

export interface DraftListParams extends OffsetQuery {
  q?: string
}

export interface DraftLineInput {
  variantId: string
  quantity: number
}

export interface AddressInput {
  firstName: string
  lastName: string
  company?: string | null
  line1: string
  line2?: string | null
  city: string
  region?: string | null
  postalCode?: string | null
  countryCode: string
  phone?: string | null
}

export interface DraftPatch {
  customerId?: string | null
  email?: string
  phone?: string | null
  paymentMethod?: string
  shippingMethodId?: string | null
  discountCode?: string | null
  customerNote?: string | null
  shippingAddress?: AddressInput
  billingAddress?: AddressInput
}
