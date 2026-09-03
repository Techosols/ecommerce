import { z } from 'zod'

/**
 * A customer says they have paid by bank transfer and is waiting on the shop.
 *
 * Short on purpose. Everything needed to decide is a screenshot, which cannot
 * travel usefully in an email — so this carries only enough to judge urgency
 * and a link to the queue. The claimed sender details are here because they are
 * what somebody will search their bank statement for, and they are labelled as
 * a claim for the same reason they are in the admin.
 */
export const adminPaymentProofProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  total: z.string(),
  customerEmail: z.email(),

  claimedSenderName: z.string(),
  claimedSenderBank: z.string(),
  claimedAccountLast4: z.string().optional(),

  /** The review queue, not the image: deciding happens in the admin. */
  reviewUrl: z.url(),
})

export type AdminPaymentProofProps = z.infer<typeof adminPaymentProofProps>
