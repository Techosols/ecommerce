/**
 * Cart validators (§9.3).
 *
 * Validate external cart input before it reaches the service.
 * Never trust client-provided prices, totals, or inventory.
 */

import { z } from 'zod'

const uuidField = z.string().uuid()
const quantityField = z.number().int().min(1).max(1_000_000)

export const addToCartSchema = z.strictObject({
  variantId: uuidField,
  quantity: quantityField,
  selectedOptions: z.record(z.string(), z.string()).optional(),
  selectedModifiers: z.record(z.string(), z.unknown()).optional(),
})

export const updateCartItemSchema = z.strictObject({
  quantity: quantityField,
})

export const cartIdParam = z.strictObject({
  id: uuidField,
})

export const cartItemIdParam = z.strictObject({
  id: uuidField,
})
