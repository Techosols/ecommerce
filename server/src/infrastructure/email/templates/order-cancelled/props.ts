import { z } from 'zod'

export const orderCancelledProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  reason: z.string().optional(),
  /** True when money had already been taken and a refund is on its way. */
  refundExpected: z.boolean().default(false),
  orderUrl: z.url(),
})

export type OrderCancelledProps = z.infer<typeof orderCancelledProps>
