import { z } from 'zod'
import { webUrlField } from '../../../../shared/validation/common.js'

export const orderShippedProps = z.object({
  storeName: z.string(),
  orderNumber: z.string(),
  firstName: z.string().optional(),
  carrier: z.string().optional(),
  trackingNumber: z.string().optional(),
  /**
   * Restricted to http(s), not `z.url()`.
   *
   * A tracking URL is supplied by staff and rendered as a clickable link in
   * somebody's inbox; `z.url()` alone would accept `javascript:` and any other
   * scheme (§16.2).
   */
  trackingUrl: webUrlField.optional(),
  orderUrl: z.url(),
})

export type OrderShippedProps = z.infer<typeof orderShippedProps>
