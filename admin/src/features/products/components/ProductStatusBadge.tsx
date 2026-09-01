import { Badge, type BadgeTone } from '@/components/ui/Badge'
import type { ProductStatus } from '../types/products.types'

const statusTone: Record<ProductStatus, { tone: BadgeTone; label: string }> = {
  // Neutral, not a warning: a draft is work in progress, not a problem.
  draft: { tone: 'neutral', label: 'Draft' },
  active: { tone: 'positive', label: 'Active' },
  archived: { tone: 'warning', label: 'Archived' },
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const { tone, label } = statusTone[status]
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  )
}

/**
 * Whether the product is visible to shoppers.
 *
 * Separate from status on purpose — the two are independent on the server, and
 * "active but unpublished" is a real and common state that a single badge would
 * misrepresent.
 */
export function PublicationBadge({ channels }: { channels: string[] }) {
  if (channels.length === 0) {
    return (
      <Badge tone="neutral" size="sm">
        Not published
      </Badge>
    )
  }
  return (
    <Badge tone="info" size="sm">
      {channels.length === 1 ? `Live on ${channels[0]}` : `Live on ${channels.length} channels`}
    </Badge>
  )
}
