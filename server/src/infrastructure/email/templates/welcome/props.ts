import { z } from 'zod'

export const welcomeProps = z.object({
  firstName: z.string().optional(),
  storeUrl: z.url(),
})

export type WelcomeProps = z.infer<typeof welcomeProps>
