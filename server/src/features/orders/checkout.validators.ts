/**
 * Checkout preview query (§17.2).
 *
 * A preview needs only the destination country — enough to rate delivery —
 * plus an optional method and code. It deliberately does not take a full
 * address: quoting should not require someone to hand over their street before
 * they have decided to buy.
 */
import { z } from 'zod'
import { countryCodeField } from '../../shared/validation/common.js'

export const checkoutPreviewQuery = z.object({
  countryCode: countryCodeField,
  shippingMethodId: z.uuid().optional(),
  discountCode: z.string().trim().min(1).max(64).optional(),
  /**
   * Optional: a preview with no method named lists everything available and
   * prices the first of them, which is what a checkout page wants on first
   * paint before anyone has chosen.
   */
  paymentMethod: z.string().trim().min(1).max(40).optional(),
})
