import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/states/EmptyState'

/**
 * An address that does not exist.
 *
 * Often a product whose handle changed — the server keeps every handle a
 * product has ever had and answers the old one with the canonical address, so
 * a genuinely dead link here usually means the product is gone rather than
 * renamed.
 */
export function NotFoundPage() {
  return (
    <EmptyState
      title="That page has moved on"
      description="The link may be old, or the product may no longer be sold."
      actions={
        <Link
          to="/products"
          className="bg-brand-600 hover:bg-brand-700 inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white"
        >
          Browse the shop
        </Link>
      }
    />
  )
}
