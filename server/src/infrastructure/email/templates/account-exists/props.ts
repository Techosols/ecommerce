import { z } from 'zod'

export const accountExistsProps = z.object({
  email: z.email(),
  resetUrl: z.url(),
})

export type AccountExistsProps = z.infer<typeof accountExistsProps>
