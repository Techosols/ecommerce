import { z } from 'zod'

export const passwordChangedProps = z.object({
  /** Pre-rendered wording: Handlebars has no `eq` helper and adding one for a
   *  single template would be more machinery than the template is worth. */
  action: z.enum(['reset', 'changed']),
  changedAt: z.string(),
  supportUrl: z.url(),
})

export type PasswordChangedProps = z.infer<typeof passwordChangedProps>
