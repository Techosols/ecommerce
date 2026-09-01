import { ProductCard } from './ProductCard'
import { Skeleton } from '@/components/ui/Skeleton'
import { useProducts } from '../hooks/catalogue.hooks'

/**
 * More from the shop, shown under a product.
 *
 * There is no "related products" endpoint and this does not pretend otherwise:
 * it asks for a page of the catalogue and drops the product already on screen.
 * That is honestly a *recommendation* only in the loosest sense, which is why
 * the heading says "More from the shop" rather than "You might also like" — a
 * promise the data cannot keep.
 *
 * Doing better needs the server to know something this page does not: what
 * sells together, or which collection the shopper came in through. Inventing an
 * affinity in the browser would be merchandising made up on the client, which
 * is the one thing the storefront does not do.
 */
export function RelatedProducts({ handle }) {
  // One more than shown, so dropping the current product still fills the row.
  const query = useProducts({ page: 1, limit: 5 })
  const others = (query.data?.items ?? [])
    .filter((product) => product.handle !== handle)
    .slice(0, 4)

  if (query.isPending) {
    return (
      <section className="flex flex-col gap-5">
        <Skeleton className="h-7 w-48" />
        <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="rounded-card h-72" />
          ))}
        </div>
      </section>
    )
  }

  // Nothing to say rather than an empty shelf: a shop with one product should
  // not render a heading over a blank row.
  if (others.length === 0) return null

  return (
    <section className="border-line flex flex-col gap-5 border-t pt-10">
      <h2 className="text-2xl">More from the shop</h2>
      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {others.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  )
}
