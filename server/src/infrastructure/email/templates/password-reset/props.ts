import { z } from 'zod'

export const passwordResetProps = z.object({
  resetUrl: z.url(),
  expiresInMinutes: z.number().int().positive(),
})

export type PasswordResetProps = z.infer<typeof passwordResetProps>
