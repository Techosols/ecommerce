/**
 * Return request schemas (§17.2). Strict throughout.
 *
 * Notice what receiving does *not* accept: a restocked quantity. The service
 * derives that from the condition — resellable units go back, the rest do not —
 * because letting a client send both invites a request that says "damaged, and
 * put all three back on the shelf".
 */
import { z } from 'zod'
import { offsetPaginationQuery } from '../../shared/http/pagination.js'
import { RETURN_CONDITIONS, RETURN_REASONS, RETURN_STATUSES } from './returns.types.js'

export const returnIdParam = z.strictObject({ id: z.uuid() })

export const openReturnSchema = z.strictObject({
  reason: z.enum(RETURN_REASONS),
  customerNote: z.string().trim().max(1000).nullable().optional(),
  lines: z
    .array(
      z.strictObject({
        orderItemId: z.uuid(),
        quantity: z.number().int().positive().max(100_000),
      }),
    )
    .min(1)
    .max(200),
})

/** Approve, decline, mark in transit, cancel and close all carry only a note. */
export const staffNoteSchema = z.strictObject({
  staffNote: z.string().trim().max(1000).nullable().optional(),
})

export const receiveReturnSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        orderItemId: z.uuid(),
        /** Zero is a real answer: "this one did not turn up". */
        receivedQuantity: z.number().int().min(0).max(100_000),
        condition: z.enum(RETURN_CONDITIONS),
      }),
    )
    .min(1)
    .max(200),
  staffNote: z.string().trim().max(1000).nullable().optional(),
})

/**
 * Refunding a return.
 *
 * The amount is explicit rather than derived, because what a shop pays back is
 * a decision — a restocking fee, postage withheld, a goodwill top-up — and the
 * refund endpoint's own limits are what keep it honest.
 */
export const refundReturnSchema = z.strictObject({
  paymentId: z.uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().max(500).nullable().optional(),
  staffNote: z.string().trim().max(1000).nullable().optional(),
})

export const returnListQuery = offsetPaginationQuery.extend({
  status: z.enum(RETURN_STATUSES).optional(),
  orderId: z.uuid().optional(),
})

export const myReturnListQuery = offsetPaginationQuery
