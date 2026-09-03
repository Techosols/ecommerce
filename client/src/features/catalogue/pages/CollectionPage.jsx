import { useParams, useSearchParams } from 'react-router-dom'
import { PackageSearch } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/states/EmptyState'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { EVENTS } from '@/lib/analytics'
import { useTrackOnce } from '@/lib/useTrack'
import { ProductCard } from '../components/ProductCard'
import { ProductGridSkeleton } from './ProductListPage'
import { useCollection, useProducts } from '../hooks/catalogue.hooks'

const PER_PAGE = 12

/**
 * One collection and what is in it.
 *
 * Two requests rather than one, because they answer different questions and
 * change at different rates: the collection itself is cached for minutes,
 * while the products in it carry live availability and are not.
 *
 * A smart collection holds whatever matches its rules at the moment somebody
 * looks — nothing is stored — so this page is always current without anything
 * being rebuilt.
 */
export function CollectionPage() {
  const { handle } = useParams()
  const [params, setParams] = useSearchParams()
  const page = Number(params.get('page') ?? '1')

  const collection = useCollection(handle)
  const products = useProducts({ page, limit: PER_PAGE, collection: handle })

  useTrackOnce(EVENTS.COLLECTION_VIEWED, collection.data ? handle : null, {
    handle,
    title: collection.data?.title,
  })

  function setPage(next) {
    const updated = new URLSearchParams(params)
    updated.set('page', String(next))
    setParams(updated)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="flex flex-col gap-8">
      <QueryBoundary
        isLoading={collection.isPending}
        error={collection.error}
        onRetry={() => void collection.refetch()}
        fallback={<Skeleton className="h-16 w-2/3" />}
      >
        {collection.data ? (
          <header className="flex flex-col gap-3">
            <h1 className="text-3xl sm:text-4xl">{collection.data.title}</h1>
            {collection.data.description ? (
              // HTML, written in the admin's editor. The server sanitises it
              // against a fixed allowlist on the way in, so what arrives here
              // cannot carry a script, an event handler or a stylesheet — see
              // `shared/validation/richText.ts` on the server for the list.
              <div
                className="rte-content text-muted max-w-2xl text-lg"
                dangerouslySetInnerHTML={{ __html: collection.data.description }}
              />
            ) : null}
          </header>
        ) : null}
      </QueryBoundary>

      <QueryBoundary
        isLoading={products.isPending}
        error={products.error}
        onRetry={() => void products.refetch()}
        fallback={<ProductGridSkeleton />}
      >
        {(products.data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title="Nothing in here yet"
            description="This collection has no products at the moment. Have a look at the rest of the shop."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.data.items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
            <Pagination pagination={products.data?.pagination} onPageChange={setPage} />
          </>
        )}
      </QueryBoundary>
    </div>
  )
}
