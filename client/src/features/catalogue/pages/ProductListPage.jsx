import { useSearchParams } from 'react-router-dom'
import { PackageSearch } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Pagination } from '@/components/ui/Pagination'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { ProductCard, ProductCardSkeleton } from '../components/ProductCard'
import { ListingControls } from '../components/ListingControls'
import { EVENTS } from '@/lib/analytics'
import { useTrackOnce } from '@/lib/useTrack'
import { useProducts } from '../hooks/catalogue.hooks'

const PER_PAGE = 12

/**
 * Everything for sale, narrowed by whatever the URL says.
 *
 * The URL is the state. Search term, collection and page all live in the query
 * string, so a filtered listing can be linked, reloaded and reached with the
 * back button — none of which is true of a filter held in component state.
 *
 * Filtering happens on the server, over the whole catalogue. Filtering a page
 * of twelve in the browser would silently mean "search the twelve you can
 * already see", which is not what anybody types a search box expecting.
 *
 * Sorting and filtering are the server's too, for the same reason: `sort`,
 * `minPrice`, `maxPrice` and `inStock` are all real query parameters, and the
 * page count comes back matching the filtered set. A sort control that only
 * reordered the twelve products on screen would be the same lie as a search box
 * that only searched them.
 */
export function ProductListPage() {
  const [params, setParams] = useSearchParams()

  const page = Number(params.get('page') ?? '1')
  const q = params.get('q') ?? ''
  const collection = params.get('collection') ?? ''
  const sort = params.get('sort') ?? ''
  const minPrice = params.get('minPrice') ?? ''
  const maxPrice = params.get('maxPrice') ?? ''
  const inStock = params.get('inStock') === 'true'

  const query = useProducts({
    page,
    limit: PER_PAGE,
    ...(q ? { q } : {}),
    ...(collection ? { collection } : {}),
    ...(sort ? { sort } : {}),
    ...(minPrice ? { minPrice } : {}),
    ...(maxPrice ? { maxPrice } : {}),
    ...(inStock ? { inStock: 'true' } : {}),
  })

  // Keyed on the term alone, so paging through results is not counted as
  // searching again — and not counted at all while browsing with no term, or
  // before the answer has come back.
  useTrackOnce(EVENTS.SEARCH_PERFORMED, q && query.data ? q : null, {
    term: q,
    results: query.data?.pagination?.total,
  })

  function setPage(next) {
    const updated = new URLSearchParams(params)
    updated.set('page', String(next))
    setParams(updated)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function clearFilters() {
    setParams(new URLSearchParams())
  }

  const isFiltered = Boolean(q || collection || sort || minPrice || maxPrice || inStock)
  const items = query.data?.items ?? []

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl sm:text-4xl">{q ? `Results for “${q}”` : 'Everything'}</h1>
      </header>

      <ListingControls
        params={params}
        total={query.data?.pagination?.total ?? null}
        onChange={(next) => setParams(next)}
      />

      <QueryBoundary
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        fallback={<ProductGridSkeleton />}
      >
        {items.length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title={isFiltered ? 'Nothing matched that' : 'Nothing is for sale yet'}
            description={
              isFiltered
                ? 'Try a wider price range, a shorter search, or browse a collection from the menu.'
                : 'Check back soon — the shop is being stocked.'
            }
            actions={
              isFiltered ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>

            <Pagination pagination={query.data?.pagination} onPageChange={setPage} />
          </>
        )}
      </QueryBoundary>
    </div>
  )
}

export function ProductGridSkeleton({ count = 6 }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} />
      ))}
    </div>
  )
}
