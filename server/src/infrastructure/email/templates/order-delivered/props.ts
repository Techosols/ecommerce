import { z } from 'zod'

export const orderDeliveredProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  orderUrl: z.url(),
})

export type OrderDeliveredProps = z.infer<typeof orderDeliveredProps>
