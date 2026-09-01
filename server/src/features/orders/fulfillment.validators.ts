/**
 * Payment, refund and shipment request schemas (§17.2). Strict throughout.
 *
 * `amountCents` appears exactly twice in this file, and both are deliberate:
 *
 *   • on a payment it is **optional**, and omitting it — the normal case —
 *     means "the outstanding balance", which the server computes. Supplying it
 *     allows a genuine part-payment, and the service still refuses anything
 *     above what is owed.
 *   • on a refund it is **required**, because a partial refund has no default
 *     and "refund everything" should be an explicit number, not an omission.
 */
import { z } from 'zod'
import { webUrlField } from '../../shared/validation/common.js'

export const recordPaymentSchema = z.strictObject({
  /**
   * Omitted means "however this order was placed" — recording a cash-on-
   * delivery collection should not require repeating that it was COD, and
   * repeating it is a chance to record it wrongly.
   */
  method: z.enum(['manual', 'cod', 'bank_transfer', 'card']).optional(),
  provider: z.string().trim().min(1).max(40).optional(),
  providerPaymentId: z.string().trim().min(1).max(200).optional(),
  amountCents: z.number().int().positive().optional(),
})

/**
 * A refund is an amount of money; restocking is a number of units. They are
 * different quantities and the request has to say both.
 *
 * `items` is **required whenever `restock` is true**, and that is the whole
 * point of this schema. Without it there is no way to know how much came back:
 * a £1 goodwill refund on a three-unit line is not three units returning to the
 * shelf, and treating it as one is how a shop ends up selling stock it does not
 * have.
 *
 * A money-only refund — the goodwill case — simply omits both.
 */
export const refundSchema = z
  .strictObject({
    paymentId: z.uuid(),
    amountCents: z.number().int().positive(),
    reason: z.string().trim().max(500).nullable().optional(),
    /** Whether the goods come back on the shelf. Damaged returns often do not. */
    restock: z.boolean().optional(),
    /** Which units are being refunded. Required to restock; recorded either way. */
    items: z
      .array(
        z.strictObject({
          orderItemId: z.uuid(),
          quantity: z.number().int().positive().max(100_000),
        }),
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .refine((value) => !value.restock || (value.items?.length ?? 0) > 0, {
    message: 'restocking needs the items and quantities coming back',
    path: ['items'],
  })

export const createShipmentSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        orderItemId: z.uuid(),
        quantity: z.number().int().positive().max(100_000),
      }),
    )
    .min(1)
    .max(200),
  carrier: z.string().trim().max(80).nullable().optional(),
  service: z.string().trim().max(80).nullable().optional(),
  trackingNumber: z.string().trim().max(120).nullable().optional(),
  // Restricted to http(s): this becomes a link a customer clicks, and `z.url()`
  // alone would happily accept `javascript:`.
  trackingUrl: webUrlField.nullable().optional(),
})

export const shipmentStatusSchema = z.strictObject({
  status: z.enum(['pending', 'processing', 'shipped', 'in_transit', 'delivered', 'returned', 'failed']),
})

export const shipmentIdParam = z.strictObject({ shipmentId: z.uuid() })
