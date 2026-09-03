import { z } from 'zod'

/**
 * What a member of staff needs to know about a new order without opening the
 * admin — and, when they do need to open it, a direct link.
 *
 * Deliberately wider than the customer's `order-placed`: it carries the payment
 * method and whether the money has actually arrived, which is the difference
 * between "pack this" and "wait". Money arrives already formatted, for the same
 * reason as everywhere else — the template is the last place a rounding decision
 * should be made.
 */
export const adminOrderPlacedProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  placedAt: z.string(),

  customerName: z.string().optional(),
  customerEmail: z.email(),
  customerPhone: z.string().optional(),
  /** Whether this email already belonged to somebody who had bought before. */
  isReturningCustomer: z.boolean().optional(),

  items: z.array(
    z.object({
      title: z.string(),
      variant: z.string().optional(),
      sku: z.string().optional(),
      quantity: z.number().int().positive(),
      total: z.string(),
    }),
  ),

  subtotal: z.string(),
  discount: z.string().optional(),
  discountCode: z.string().optional(),
  shipping: z.string(),
  tax: z.string().optional(),
  total: z.string(),

  // ── The part the customer's copy does not have ──────────────────────────
  paymentMethod: z.string(),
  /** "Paid" or "Awaiting payment" — plain words, not the wire enum. */
  paymentStatus: z.string(),
  /** Set when the order cannot be packed yet, and says why in one line. */
  actionNeeded: z.string().optional(),

  shippingAddress: z.string(),
  billingAddress: z.string().optional(),
  shippingMethod: z.string().optional(),
  customerNote: z.string().optional(),

  /** Straight into the admin's order page. */
  adminUrl: z.url(),
})

export type AdminOrderPlacedProps = z.infer<typeof adminOrderPlacedProps>
