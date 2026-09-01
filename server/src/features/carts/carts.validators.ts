import { z } from 'zod'

export const addItemSchema = z.strictObject({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(999).default(1),
})

export const setQuantitySchema = z.strictObject({
  quantity: z.number().int().min(0).max(999),
})

export const variantParam = z.strictObject({ variantId: z.uuid() })

export const cartIdParam = z.strictObject({ id: z.uuid() })

/**
 * The admin's view of the cart pile.
 *
 * `withItemsOnly` defaults to true and that default is the point: an empty cart
 * is created by anybody who so much as looks at the shop, and a list dominated
 * by them answers nothing. What a shop wants to see is baskets somebody
 * actually filled and then left.
 */
export const cartListQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['active', 'abandoned', 'converted']).optional(),
  /** Matches the customer's email or name. */
  q: z.string().trim().min(1).max(120).optional(),
  withItemsOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
})
