import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { useStoreSettings } from '@/features/settings/useSettings'
import { ProductCard } from '../components/ProductCard'
import { ProductGridSkeleton } from './ProductListPage'
import { useCollections, useProducts } from '../hooks/catalogue.hooks'

/**
 * The front of the shop.
 *
 * One job: make it obvious what is sold here and give two ways in — a
 * collection or a product. Everything on it is real, fetched from the same endpoints the
 * rest of the storefront uses; there is no curated "featured" list, because
 * the server publishes no way to curate one and inventing an order here would
 * be a merchandising decision made in a browser.
 */
export function HomePage() {
  const settings = useStoreSettings()
  const featured = useProducts({ page: 1, limit: 6 })
  const collections = useCollections()

  const groups = (collections.data ?? []).slice(0, 6)

  return (
    <div className="flex flex-col gap-16">
      <section className="border-line bg-surface rounded-card relative overflow-hidden border px-6 py-14 sm:px-12 sm:py-20">
        {/* A quiet wash of the brand colour, so the hero has depth without a
            gradient doing the shouting. */}
        <div
          aria-hidden="true"
          className="from-brand-50 pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent"
        />
        <div className="relative flex max-w-2xl flex-col gap-5">
          <p className="text-copper-600 text-sm font-medium tracking-widest uppercase">
            Kitchen · Bakery · Roastery
          </p>
          <h1 className="text-4xl leading-[1.1] sm:text-6xl">
            {settings?.storeName ?? 'The shop'}
          </h1>
          <p className="text-muted max-w-lg text-lg leading-relaxed">
            Bread proved overnight, coffee roasted on Tuesdays, and everything else made the
            morning you eat it.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            {/* A link, styled as a button. It navigates, so it must be an
                anchor: a <button> here would break middle-click, "open in new
                tab", and every other thing a person expects of a link. */}
            <Link
              to="/products"
              className="bg-brand-600 shadow-card hover:bg-brand-700 inline-flex h-12 items-center gap-2 rounded-lg px-6 text-base font-medium text-white transition-colors"
            >
              Browse everything
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      {groups.length > 0 ? (
        <section className="flex flex-col gap-5">
          <h2 className="text-2xl">Have a look through</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((collection) => (
              <Link
                key={collection.handle}
                to={`/collections/${collection.handle}`}
                className="group border-line bg-surface hover:border-brand-300 rounded-card flex flex-col gap-1 border px-5 py-4 transition-colors"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-ink font-medium">{collection.title}</span>
                  <ArrowRight className="text-faint group-hover:text-brand-600 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </span>
                {collection.description ? (
                  <span className="text-muted line-clamp-2 text-sm">{collection.description}</span>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-2xl">In the shop</h2>
          <Link to="/products" className="text-brand-600 text-sm font-medium hover:underline">
            See everything
          </Link>
        </div>

        <QueryBoundary
          isLoading={featured.isPending}
          error={featured.error}
          onRetry={() => void featured.refetch()}
          fallback={<ProductGridSkeleton />}
        >
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {(featured.data?.items ?? []).map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </QueryBoundary>
      </section>
    </div>
  )
}
