import { z } from 'zod'

export const cartAbandonedProps = z.object({
  storeName: z.string(),
  firstName: z.string().optional(),
  items: z.array(
    z.object({
      title: z.string(),
      variant: z.string().optional(),
      quantity: z.number().int().positive(),
    }),
  ),
  cartUrl: z.url(),
})

export type CartAbandonedProps = z.infer<typeof cartAbandonedProps>
