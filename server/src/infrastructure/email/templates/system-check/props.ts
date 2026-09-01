/**
 * Props for the only template the foundation ships.
 *
 * It exists for an operational reason, not a business one: it is how an
 * operator verifies that provider credentials, rendering and the worker
 * pipeline all work in a new environment. Feature templates (verification,
 * order confirmation, shipment shipped …) arrive with their features (§10.5).
 */
import { z } from 'zod'

export const systemCheckProps = z.object({
  environment: z.string(),
  triggeredAt: z.string(),
  note: z.string().optional(),
})

export type SystemCheckProps = z.infer<typeof systemCheckProps>
