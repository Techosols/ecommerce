import { z } from 'zod'

/**
 * Every money value arrives as an already-formatted string.
 *
 * The template is the last place a rounding decision should be made, and
 * Handlebars cannot divide by 100 correctly anyway. Formatting happens once, in
 * the subscriber, from the order's own integer minor units.
 */
export const orderPlacedProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  placedAt: z.string(),
  items: z.array(
    z.object({
      title: z.string(),
      variant: z.string().optional(),
      quantity: z.number().int().positive(),
      total: z.string(),
    }),
  ),
  subtotal: z.string(),
  discount: z.string().optional(),
  shipping: z.string(),
  tax: z.string().optional(),
  total: z.string(),
  shippingAddress: z.string(),
  shippingMethod: z.string().optional(),
  orderUrl: z.url(),
})

export type OrderPlacedProps = z.infer<typeof orderPlacedProps>
