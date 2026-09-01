import { z } from 'zod'

export const orderConfirmedProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  total: z.string(),
  orderUrl: z.url(),
})

export type OrderConfirmedProps = z.infer<typeof orderConfirmedProps>
