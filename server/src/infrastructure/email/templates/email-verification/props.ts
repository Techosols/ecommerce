import { z } from 'zod'

export const emailVerificationProps = z.object({
  verificationUrl: z.url(),
  expiresInHours: z.number().int().positive(),
})

export type EmailVerificationProps = z.infer<typeof emailVerificationProps>
