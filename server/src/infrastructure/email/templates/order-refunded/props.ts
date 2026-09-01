import { z } from 'zod'

export const orderRefundedProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  amount: z.string(),
  reason: z.string().optional(),
  /** True when the refund covers the whole order rather than part of it. */
  full: z.boolean().default(false),
  orderUrl: z.url(),
})

export type OrderRefundedProps = z.infer<typeof orderRefundedProps>
