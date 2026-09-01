/**
 * Inventory request schemas (§17.2).
 *
 * Strict throughout. Two inventory-specific rules:
 *
 *   • **An adjustment is a signed delta, never an assignment.** There is no
 *     `{ onHand: 47 }` anywhere in this file. Setting a number races with every
 *     concurrent movement and destroys the question an auditor asks — *why 47?*
 *     `POST /stocktake` exists for a real count and computes the delta itself.
 *
 *   • **No endpoint accepts `available` or `reserved`.** `available` is derived
 *     by the database, and `reserved` moves only through reservations.
 */
import { z } from 'zod'
import { slugField } from '../../shared/validation/common.js'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'

/** Reasons an operator may cite. System reasons are written by the services. */
export const OPERATOR_REASONS = [
  'receive',
  'manual_adjustment',
  'stocktake',
  'damage',
  'waste',
  'return',
  'correction',
] as const

const quantityField = z.number().int().min(1).max(1_000_000)
const deltaField = z
  .number()
  .int('stock moves in whole units')
  .min(-1_000_000)
  .max(1_000_000)
  .refine((value) => value !== 0, { message: 'an adjustment must move stock' })

/** A target is a variant or an inventory item — exactly one of them. */
const target = {
  variantId: z.uuid().optional(),
  inventoryItemId: z.uuid().optional(),
  locationId: z.uuid().optional(),
}

const exactlyOneTarget = <T extends { variantId?: string; inventoryItemId?: string }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  const supplied = [value.variantId, value.inventoryItemId].filter(Boolean).length
  if (supplied !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Supply exactly one of variantId or inventoryItemId',
      path: ['variantId'],
    })
  }
}

export const adjustmentSchema = z
  .strictObject({
    ...target,
    delta: deltaField,
    reason: z.enum(OPERATOR_REASONS),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine(exactlyOneTarget)

export const stocktakeSchema = z
  .strictObject({
    ...target,
    countedOnHand: z.number().int().min(0).max(1_000_000),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine(exactlyOneTarget)

export const transferSchema = z
  .strictObject({
    variantId: z.uuid().optional(),
    inventoryItemId: z.uuid().optional(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity: quantityField,
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine(exactlyOneTarget)

export const updateItemSchema = z
  .strictObject({
    trackInventory: z.boolean(),
    // null restores the store default, which is not the same as 0.
    lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .partial()

export const reserveSchema = z
  .strictObject({
    ...target,
    quantity: quantityField,
    ownerType: z.enum(['cart', 'order', 'manual']),
    ownerId: z.uuid(),
    expiresInMinutes: z.number().int().min(1).max(43_200).optional(),
  })
  .superRefine(exactlyOneTarget)

export const createLocationSchema = z.strictObject({
  code: slugField.max(40),
  name: z.string().trim().min(1).max(120),
  address: z.record(z.string(), z.unknown()).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  isDefault: z.boolean().optional(),
})

export const updateLocationSchema = z
  .strictObject({
    code: slugField.max(40),
    name: z.string().trim().min(1).max(120),
    address: z.record(z.string(), z.unknown()),
    isActive: z.boolean(),
    isDefault: z.boolean(),
    position: z.number().int().min(0).max(10_000),
  })
  .partial()

export const itemListQuery = offsetPaginationQuery.extend({
  low: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  // Whether stock is counted at all, which is a different question from
  // whether there is any: an untracked item is unconditionally sellable.
  tracked: z.enum(['true', 'false']).optional(),
  // SKU, variant title or product title — an operator has one of the three in
  // their hand and should not have to know which the shop calls it.
  q: z.string().trim().min(1).max(120).optional(),
  // Narrows the totals to one location, not which items appear: an item
  // stocked nowhere else still shows, at zero, so its absence is visible.
  locationId: z.uuid().optional(),
})

export const movementListQuery = offsetPaginationQuery.extend({
  locationId: z.uuid().optional(),
  reason: z
    .enum([
      ...OPERATOR_REASONS,
      'transfer_in',
      'transfer_out',
      'reservation',
      'reservation_release',
      'reservation_commit',
      'reservation_expired',
    ])
    .optional(),
})

export const idParam = z.strictObject({ id: z.uuid() })
export const variantParam = z.strictObject({ variantId: z.uuid() })
