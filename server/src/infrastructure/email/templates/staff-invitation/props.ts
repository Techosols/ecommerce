import { z } from 'zod'

export const staffInvitationProps = z.object({
  storeName: z.string(),
  invitedBy: z.string(),
  roles: z.string(),
  acceptUrl: z.url(),
  expiresInHours: z.number().int().positive(),
})

export type StaffInvitationProps = z.infer<typeof staffInvitationProps>
